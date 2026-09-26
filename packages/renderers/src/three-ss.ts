// three-ss: WebGPURenderer + RenderPipeline replicating examples/webgpu_postprocessing_ssgi.html (antialias 'traa')
// and examples/webgpu_postprocessing_ssr.html (antialias 'smaa') of the three.js fork.
import { LinearSRGBColorSpace, NoToneMapping } from 'three';
import {
  PMREMGenerator,
  RenderPipeline,
  RedIntegerFormat,
  UnsignedByteType,
  UnsignedIntType,
  WebGPURenderer,
} from 'three/webgpu';
import {
  builtinGIContext,
  builtinRadianceContext,
  ceil,
  color,
  exp2,
  float,
  Fn,
  ivec2,
  log2,
  materialMetalness,
  materialRoughness,
  metalness,
  mix,
  mrt,
  normalView,
  packNormalToRGB,
  pass,
  perspectiveDepthToViewZ,
  reference,
  round,
  roughness,
  rtt,
  sample,
  screenUV,
  smoothstep,
  texture,
  textureSize,
  uint,
  unpackRGBToNormal,
  uvec2,
  uvec3,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { previousFrameGeometry, temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { SceneEffects, SceneSetup } from '@ss-fidelity/scenes';
import type { LiveRenderer, PassName, RendererOptions } from './types.js';

/** SSGINode's AO frames: the temporal denoiser converges at ~64 (see PLAN.md). */
const AO_FRAMES = 128;

/** The three-ss pipeline settings of a pass. */
export function passEffects(setup: SceneSetup, renderPass: PassName): SceneEffects {
  const { effects } = setup;
  switch (renderPass) {
    case 'beauty':
      return effects;
    case 'direct':
      // the ssgi example's "Direct" output: the scene pass without the GI/radiance contexts
      return { ...effects, ssgi: undefined, ssr: undefined, temporalDenoise: false };
    case 'ao':
      // SSGINode's AO comparable to ray-traced AO: world-space radius, linear visibility (aoIntensity 1), no fade;
      // slice/step counts and thickness stay the scene's (the ssgi example's defaults for scenes without SSGI)
      return {
        ...effects,
        ssgi: {
          sliceCount: effects.ssgi?.sliceCount ?? 2,
          stepCount: effects.ssgi?.stepCount ?? 8,
          giIntensity: 0,
          radius: setup.aoRadius,
          thickness: effects.ssgi?.thickness,
          aoIntensity: 1,
          useScreenSpaceSampling: false,
        },
        ssr: undefined,
        temporalDenoise: true,
        toneMapping: NoToneMapping,
        toneMappingExposure: 1,
        frames: Math.max(effects.frames, AO_FRAMES),
      };
  }
}

// The fork's TSL nodes are ahead of @types/three; the graph is built exactly as in the examples, so it is typed loosely.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyNode = any;

/** Per-component sign of a vec2 that never returns 0 (for the octahedral normal encoding). */
const octSign = (v: AnyNode): AnyNode =>
  vec2(v.x.greaterThanEqual(0).select(1, -1), v.y.greaterThanEqual(0).select(1, -1));

/**
 * Packs HDR radiance and a unit normal into 32 bits: the radiance as shared-exponent RGB (5-bit mantissas, 5-bit
 * exponent) in bits 0-19, the normal octahedrally (6 + 6 bits) in bits 20-31.
 */
const packRadianceNormal = (radiance: AnyNode, normal: AnyNode): AnyNode =>
  Fn(() => {
    const rgb = radiance.max(0).toConst();
    const exponent = ceil(
      log2(
        rgb.x
          .max(rgb.y)
          .max(rgb.z)
          .max(2 ** -16),
      ),
    )
      .clamp(-15, 16)
      .toConst();
    const mantissas: AnyNode = uvec3(round(rgb.mul(exp2(exponent.negate())).mul(31)).min(31) as AnyNode);
    const oct = normal.xy.div(normal.x.abs().add(normal.y.abs()).add(normal.z.abs())).toConst();
    const folded = normal.z.lessThan(0).select(vec2(1).sub(oct.yx.abs()).mul(octSign(oct)), oct);
    const octBits: AnyNode = uvec2(round(folded.mul(0.5).add(0.5).mul(63)) as AnyNode);
    return mantissas.x
      .bitOr(mantissas.y.shiftLeft(5))
      .bitOr(mantissas.z.shiftLeft(10))
      .bitOr((uint(exponent.add(15)) as AnyNode).shiftLeft(15))
      .bitOr(octBits.x.shiftLeft(20))
      .bitOr(octBits.y.shiftLeft(26));
  })();

/** Inverse of {@link packRadianceNormal}: the radiance. */
const unpackRadiance = (bits: AnyNode): AnyNode =>
  vec3((uvec3(bits, bits.shiftRight(5), bits.shiftRight(10)) as AnyNode).bitAnd(uvec3(31))).mul(
    exp2(float(bits.shiftRight(15).bitAnd(31)).sub(15)).div(31),
  );

/** Inverse of {@link packRadianceNormal}: the (unnormalized) normal. */
const unpackNormal = (bits: AnyNode): AnyNode =>
  Fn(() => {
    const oct = vec2((uvec2(bits.shiftRight(20), bits.shiftRight(26)) as AnyNode).bitAnd(uvec2(63)))
      .div(63 / 2)
      .sub(1)
      .toConst();
    const z = float(1).sub(oct.x.abs()).sub(oct.y.abs()).toConst();
    return vec3(oct.sub(octSign(oct).mul(z.negate().max(0))), z);
  })();

function createPipeline(renderer: WebGPURenderer, setup: SceneSetup, aoOutput: boolean): RenderPipeline {
  const { scene, camera, effects } = setup;
  const tsl = {
    ssr: ssr as AnyNode,
    temporalReproject: temporalReproject as AnyNode,
    recurrentDenoise: recurrentDenoise as AnyNode,
    builtinGIContext: builtinGIContext as AnyNode,
    builtinRadianceContext: builtinRadianceContext as AnyNode,
  };
  const ssgiExample = effects.antialias === 'traa';
  const resolutionScale = effects.resolutionScale ?? 1;

  const renderPipeline = new RenderPipeline(renderer);

  // pre-pass: SSGI/SSR run before the scene pass so their results can light the materials, which means depth,
  // normals and velocity have to come from a separate pass
  const prePass = pass(scene, camera);
  prePass.name = 'Pre-Pass';
  prePass.transparent = false;
  prePass.setMRT(
    mrt({
      output: packNormalToRGB(normalView),
      velocity,
      // the ssgi example packs the material uniforms, the ssr example the (texture-mapped) material properties
      metalRoughness: ssgiExample ? vec2(materialMetalness, materialRoughness) : vec2(metalness, roughness),
    }),
  );
  const prePassNormal: AnyNode = prePass.getTextureNode();
  const prePassDepth: AnyNode = prePass.getTextureNode('depth');
  const prePassVelocity: AnyNode = prePass.getTextureNode('velocity');
  prePass.getTexture('metalRoughness').type = UnsignedByteType;
  const prePassMetalRoughness: AnyNode = prePass.getTextureNode('metalRoughness').sample(screenUV);
  const sceneNormal = sample((uv: AnyNode) => unpackRGBToNormal(prePassNormal.sample(uv)));

  // scene pass, anti-aliased; the effects sample its previous (anti-aliased) frame reprojected to the current one
  const scenePass = pass(scene, camera);
  const aaPass: AnyNode = ssgiExample ? traa(scenePass, prePassDepth, prePassVelocity, camera) : smaa(scenePass);
  const previousFrame = texture(aaPass.getTextureNode().value);
  const previousRadiance = sample((uv: AnyNode) =>
    previousFrame.sample(uv.sub(prePassVelocity.sample(uv).xy.mul(vec2(0.5, -0.5)))),
  );

  const temporal = effects.temporalDenoise;
  const sharedPreviousFrame = temporal ? previousFrameGeometry(prePassDepth, prePassNormal) : null;
  const temporalDenoise = (signal: AnyNode): AnyNode => {
    const reprojected = tsl.temporalReproject(signal, prePassDepth, prePassNormal, prePassVelocity, camera, {
      previousFrameGeometry: sharedPreviousFrame,
    });
    const denoised = tsl.recurrentDenoise(reprojected, camera, {
      depth: prePassDepth,
      normal: prePassNormal,
      raw: signal,
    });
    denoised.alphaSource = 'none';
    denoised.useTemporalFiltering = true;
    reprojected.setHistoryTexture(denoised);
    reprojected.resolutionScale = denoised.resolutionScale = resolutionScale;
    return denoised.getTextureNode();
  };

  let giPass: AnyNode = null;
  if (effects.ssgi) {
    // SSGI samples the radiance ~32 times per pixel; reprojecting it once into a texture replaces each sample's
    // dependent velocity + previous-frame fetch pair with a single fetch. The sampled light sources' normals (only
    // tested for which way they face) are packed into the same 32 bits, so that one scattered (point-sampled) fetch
    // serves both; the shading point's own normal keeps full precision.
    const packed: AnyNode = rtt(
      packRadianceNormal(previousRadiance.sample(screenUV).rgb, sceneNormal.sample(screenUV).rgb),
      null,
      null,
      { type: UnsignedIntType, format: RedIntegerFormat },
    );
    const packedSize = vec2(textureSize(packed) as AnyNode);
    const loadPacked = (uv: AnyNode): AnyNode => packed.load(ivec2(uv.mul(packedSize))).x;
    giPass = ssgi(
      sample((uv: AnyNode) => unpackRadiance(loadPacked(uv))),
      prePassDepth,
      sceneNormal,
      camera,
    );
    giPass.lightNormalNode = sample((uv: AnyNode) => unpackNormal(loadPacked(uv)));
    giPass.sliceCount.value = effects.ssgi.sliceCount;
    giPass.stepCount.value = effects.ssgi.stepCount;
    giPass.giIntensity.value = effects.ssgi.giIntensity;
    giPass.useTemporalFiltering = temporal;
    giPass.resolutionScale = resolutionScale;
    const { radius, thickness, aoIntensity, useScreenSpaceSampling } = effects.ssgi;
    if (radius !== undefined) giPass.radius.value = radius;
    if (thickness !== undefined) giPass.thickness.value = thickness;
    if (aoIntensity !== undefined) giPass.aoIntensity.value = aoIntensity;
    if (useScreenSpaceSampling !== undefined) giPass.useScreenSpaceSampling.value = useScreenSpaceSampling;
  }

  let reflections: AnyNode = null;
  if (effects.ssr) {
    const params = effects.ssr;
    const ssrPass = tsl.ssr(previousRadiance, prePassDepth, sceneNormal, {
      metalnessNode: prePassMetalRoughness.r,
      roughnessNode: prePassMetalRoughness.g,
      outputRadiance: true,
      environmentNode: scene.environment ?? undefined,
      camera,
    });
    if (scene.environment) ssrPass.environmentIntensity.value = scene.environmentIntensity;
    ssrPass.maxDistance.value = params.maxDistance;
    if (params.quality !== undefined) ssrPass.quality.value = params.quality;
    if (params.blurQuality !== undefined) ssrPass.blurQuality = params.blurQuality;
    if (params.intensity !== undefined) ssrPass.intensity.value = params.intensity;
    if (params.thickness !== undefined) ssrPass.thickness.value = params.thickness;
    if (params.binaryRefine !== undefined) ssrPass.binaryRefine = params.binaryRefine;
    ssrPass.useTemporalFiltering = temporal; // without temporal accumulation the march jitter is kept fixed
    ssrPass.resolutionScale = resolutionScale;

    if (temporal) {
      // reflections are reprojected with their hit points (specular mode)
      const ssrReprojected = tsl.temporalReproject(ssrPass, prePassDepth, prePassNormal, prePassVelocity, camera, {
        mode: 'specular',
        previousFrameGeometry: sharedPreviousFrame,
      });
      ssrReprojected.maxFrames.value = 16;
      ssrReprojected.clampIntensity.value = 0.25;
      const ssrDenoised = tsl.recurrentDenoise(ssrReprojected, camera, {
        depth: prePassDepth,
        normal: prePassNormal,
        raw: ssrPass,
        metalRoughness: prePassMetalRoughness,
        mode: 'specular',
      });
      ssrDenoised.alphaSource = 'raylength';
      ssrDenoised.lumaPhi.value = 0.75;
      ssrDenoised.depthPhi.value = 20;
      ssrDenoised.normalPhi.value = 0.3;
      ssrDenoised.radius.value = 1.5;
      ssrDenoised.alphaPhi.value = 5;
      ssrDenoised.strength.value = 0.725;
      ssrDenoised.adaptiveTrust.value = 1;
      ssrDenoised.useTemporalFiltering = true;
      ssrReprojected.setHistoryTexture(ssrDenoised);
      ssrReprojected.resolutionScale = ssrDenoised.resolutionScale = resolutionScale;
      reflections = ssrDenoised.getTextureNode().sample(screenUV).rgb;
    } else {
      reflections = ssrPass.getTextureNode().sample(screenUV).rgb;
    }
  }

  const radiance = reflections ? tsl.builtinRadianceContext(reflections) : null;
  if (giPass) {
    let ao: AnyNode = (temporal ? temporalDenoise(giPass.getAONode()) : giPass.getAONode()).sample(screenUV).r;
    let gi: AnyNode = (temporal ? temporalDenoise(giPass.getGINode()) : giPass.getGINode()).sample(screenUV).rgb;
    const fadeRange = effects.ssgi?.fade;
    if (fadeRange) {
      // fade AO/GI out in the distance (webgpu_higharc_ao)
      const near = reference('near', 'float', camera) as AnyNode;
      const far = reference('far', 'float', camera) as AnyNode;
      const viewDistance = perspectiveDepthToViewZ(prePassDepth.sample(screenUV).r, near, far).negate();
      const fade = smoothstep(fadeRange.start, fadeRange.end, viewDistance);
      ao = mix(ao, float(1), fade);
      gi = gi.mul(fade.oneMinus());
    }
    if (aoOutput) {
      // the ssgi example's "AO" output; background pixels (no SSGI sample) are unoccluded
      const background = prePassDepth.sample(screenUV).r.greaterThanEqual(1);
      renderPipeline.outputNode = vec4(vec3(background.select(float(1), ao)), 1);
      return renderPipeline;
    }
    scenePass.contextNode = tsl.builtinGIContext(ao, gi, radiance);
  } else if (radiance) {
    scenePass.contextNode = radiance;
  }

  renderPipeline.outputNode = aaPass;
  return renderPipeline;
}

export async function createThreeSSRenderer(
  canvas: HTMLCanvasElement,
  sceneSetup: SceneSetup,
  { width, height, pass: renderPass }: RendererOptions,
): Promise<LiveRenderer> {
  const setup = { ...sceneSetup, effects: passEffects(sceneSetup, renderPass) };
  const { scene, camera, effects } = setup;
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  renderer.shadowMap.enabled = true;
  if (renderPass === 'ao') renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = effects.toneMapping;
  renderer.toneMappingExposure = effects.toneMappingExposure;
  await renderer.init();

  if (setup.gradientBackground) {
    const { center, edge } = setup.gradientBackground;
    scene.backgroundNode = screenUV.distance(0.5).remap(0, 0.5).mix(color(center), color(edge));
  }
  if (setup.environment) {
    const pmremGenerator = new PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(setup.environment.scene, setup.environment.sigma).texture;
    pmremGenerator.dispose();
  }

  const renderPipeline = createPipeline(renderer, setup, renderPass === 'ao');
  let frames = 0;

  const handle: LiveRenderer = {
    name: 'three-ss',
    renderer,
    get frames() {
      return frames;
    },
    render() {
      renderPipeline.render();
      frames++;
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
    },
    dispose() {
      renderPipeline.dispose();
      renderer.dispose();
    },
  };
  handle.setSize(width, height);
  return handle;
}
