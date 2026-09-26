// three-new-ssgi / three-ss-legacy / three-new-ssr: WebGPURenderer + RenderPipeline replicating
// examples/webgpu_postprocessing_ssgi.html (antialias 'traa') and examples/webgpu_postprocessing_ssr.html
// (antialias 'smaa') of the three.js fork.
import { BackSide, LinearSRGBColorSpace, NoToneMapping } from 'three';
import { MeshBasicNodeMaterial, PMREMGenerator, RenderPipeline, UnsignedByteType, WebGPURenderer } from 'three/webgpu';
import {
  builtinGIContext,
  builtinRadianceContext,
  color,
  context,
  float,
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
  roughness,
  sample,
  screenUV,
  specularColorBlended,
  specularF90,
  smoothstep,
  texture,
  unpackRGBToNormal,
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
import { newSSR } from './ssr/NewSSRNode.js';
import type { SceneEffects, SceneSetup } from '@ss-fidelity/scenes';
import type { LiveRenderer, PassName, RendererOptions, SSRFastOptions } from './types.js';

/** SSGINode's AO frames: the temporal denoiser converges at ~64 (see PLAN.md). */
const AO_FRAMES = 128;

/** three-new-ssr's minimum pipeline frames per rendered result (its stochastic SSR is a running mean over them). */
const SSR_ACCUM_FRAMES = 256;

/** The three-new-ssgi / three-ss-legacy / three-new-ssr pipeline settings of a pass. */
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

function createPipeline(
  renderer: WebGPURenderer,
  setup: SceneSetup,
  aoOutput: boolean,
  ssgiReconstruction: NonNullable<RendererOptions['ssgiReconstruction']>,
  ssgiWeighting: NonNullable<RendererOptions['ssgiWeighting']>,
  ssrMethod: NonNullable<RendererOptions['ssrMethod']>,
  ssrFast: SSRFastOptions,
): RenderPipeline {
  const { scene, camera, effects } = setup;
  const tsl = {
    ssr: (ssrMethod === 'new' ? newSSR : ssr) as AnyNode,
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
  // three-new-ssr also writes transparent surfaces (e.g. steampunk's opaque-but-transparent-flagged Lense_Casing):
  // they read their reflections from the SSR target at their own pixels, so they need depth/normal/roughness there
  prePass.transparent = ssrMethod === 'new';
  prePass.setMRT(
    mrt({
      output: packNormalToRGB(normalView),
      velocity,
      // the ssgi example packs the material uniforms, the ssr example the (texture-mapped) material properties
      metalRoughness: ssgiExample ? vec2(materialMetalness, materialRoughness) : vec2(metalness, roughness),
      // three-new-ssr re-evaluates the specular of SSR hits for the reflected ray's direction (see NewSSRNode.js)
      ...(ssrMethod === 'new' ? { specular: vec4(specularColorBlended, specularF90) } : {}),
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
  const temporalDenoise = (signal: AnyNode, spatial = true): AnyNode => {
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
    if (!spatial) {
      // Zero radius samples the same texel, and zero flicker suppression makes the feedback
      // a linear current/history blend. Keep the same reprojection and feedback chain.
      denoised.radius.value = 0;
      denoised.flickerSuppression.value = 0;
    }
    reprojected.setHistoryTexture(denoised);
    reprojected.resolutionScale = denoised.resolutionScale = resolutionScale;
    return denoised.getTextureNode();
  };

  let giPass: AnyNode = null;
  if (effects.ssgi) {
    giPass = ssgi(previousRadiance, prePassDepth, sceneNormal, camera);
    giPass.useSolidAngleWeighting.value = ssgiWeighting === 'solid-angle';
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

  // three-new-ssr: depth of the nearest back faces, so SSR knows how thick each solid actually is.
  // three-new-ssr-fast can render it at a lower resolution (SSRFastOptions.backDepthResolutionScale):
  // NewSSRNode only uses it as a coarse "is this ray still inside the solid" test with slack (`tk`), so a
  // bilinearly-sampled lower-resolution depth is an adequate approximation for a cheaper extra scene pass.
  const backDepth = (resolutionScale: number): AnyNode => {
    const backPass = pass(scene, camera);
    backPass.name = 'Back-Face Depth Pre-Pass';
    backPass.transparent = true; // like the pre-pass (three-new-ssr only)
    backPass.overrideMaterial = new MeshBasicNodeMaterial({ side: BackSide });
    if (resolutionScale !== 1) backPass.setResolutionScale(resolutionScale);
    return backPass.getTextureNode('depth');
  };

  let reflections: AnyNode = null;
  if (effects.ssr) {
    const params = effects.ssr;
    const ssrPass = tsl.ssr(previousRadiance, prePassDepth, sceneNormal, {
      metalnessNode: prePassMetalRoughness.r,
      roughnessNode: prePassMetalRoughness.g,
      outputRadiance: true,
      environmentNode: scene.environment ?? undefined,
      camera,
      // three-new-ssr is the reference configuration: stochastic VNDF rays over the full GGX lobe for every
      // material (dielectrics too), accumulated into an unbiased running mean for the static camera.
      ...(ssrMethod === 'new'
        ? {
            reflectNonMetals: true,
            stochastic: true,
            accumulate: true,
            backDepthNode: backDepth(ssrFast.backDepthResolutionScale ?? 1),
            hitMaterialNode: prePass.getTextureNode('metalRoughness'),
            hitSpecularNode: prePass.getTextureNode('specular'),
            // three-new-ssr-fast: each of these defaults to three-new-ssr's exact behavior (see
            // SSRFastOptions); the options table in index.ts is what actually turns one on.
            clipRaysToScreen: ssrFast.clipRaysToScreen ?? false,
            binaryRefineSteps: ssrFast.binaryRefineSteps ?? 8,
            secondBounceRoughnessCutoff: ssrFast.secondBounceRoughnessCutoff ?? null,
            secondBounceQuality: ssrFast.secondBounceQuality ?? null,
          }
        : {}),
    });
    if (scene.environment) ssrPass.environmentIntensity.value = scene.environmentIntensity;
    // three-new-ssr drops the fork's distance-fade/hit-rejection use of maxDistance in radiance mode
    // (see NewSSRNode.js), so its maxDistance is only a ray-length budget: use a large, scene-independent
    // value (twice the camera's far plane) instead of the scene's artistic cutoff.
    ssrPass.maxDistance.value = ssrMethod === 'new' ? camera.far * 2 : params.maxDistance;
    // three-new-ssr traces at full step density with sub-step refinement: speed does not matter for a
    // fidelity reference, and a coarse march stair-steps and skips thin geometry (the diagnostics' pole).
    // three-new-ssr-fast can trade step density for speed via ssrFast.quality (binary refinement still runs,
    // so contacts stay sharp; only the coarse march between them gets coarser).
    ssrPass.quality.value = ssrMethod === 'new' ? (ssrFast.quality ?? 1) : (params.quality ?? ssrPass.quality.value);
    if (params.blurQuality !== undefined) ssrPass.blurQuality = params.blurQuality;
    if (params.intensity !== undefined) ssrPass.intensity.value = params.intensity;
    if (params.thickness !== undefined) ssrPass.thickness.value = params.thickness;
    ssrPass.binaryRefine = ssrMethod === 'new' ? true : (params.binaryRefine ?? ssrPass.binaryRefine);
    ssrPass.useTemporalFiltering = temporal; // without temporal accumulation the march jitter is kept fixed
    ssrPass.resolutionScale = resolutionScale;
    if (ssrMethod === 'new') {
      // unbiased reference: full VNDF lobe, no luminance clamp, no screen-edge fade (a hit is a hit;
      // rays leaving the screen fall back to the environment), fresh samples every frame
      ssrPass.mirrorBias.value = 0;
      ssrPass.maxLuminance.value = 1e9;
      ssrPass.screenEdgeFade.value = 0;
      ssrPass.useTemporalFiltering = true;
    }

    if (ssrMethod === 'new') {
      // NewSSRNode accumulates internally (see `accumulate`); the clamping reprojection/denoise chain would bias it
      reflections = ssrPass.getTextureNode().sample(screenUV).rgb;
    } else if (temporal) {
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

  // builtinRadianceContext leaves transparent-flagged materials on the environment map. three-new-ssr's pre-passes
  // include them (steampunk's opaque Lense_Casing), so they take the SSR radiance too.
  const radiance = !reflections
    ? null
    : ssrMethod === 'new'
      ? (context as AnyNode)(null, {
          getRadiance: (inputNode: AnyNode) => (inputNode !== null ? inputNode.add(reflections) : reflections),
        })
      : tsl.builtinRadianceContext(reflections);
  if (giPass) {
    let ao: AnyNode = (temporal ? temporalDenoise(giPass.getAONode()) : giPass.getAONode()).sample(screenUV).r;
    const giSignal = giPass.getGINode();
    const giTexture =
      temporal && ssgiReconstruction !== 'raw'
        ? temporalDenoise(giSignal, ssgiReconstruction === 'denoised')
        : giSignal;
    let gi: AnyNode = giTexture.sample(screenUV).rgb;
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

export async function createSSGIRenderer(
  canvas: HTMLCanvasElement,
  sceneSetup: SceneSetup,
  {
    width,
    height,
    pass: renderPass,
    ssgiReconstruction = 'denoised',
    ssgiWeighting = 'solid-angle',
    ssrMethod = 'fork',
    ssrFast,
  }: RendererOptions,
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

  const renderPipeline = createPipeline(
    renderer,
    setup,
    renderPass === 'ao',
    ssgiReconstruction,
    ssgiWeighting,
    ssrMethod,
    ssrFast ?? {},
  );
  let frames = 0;
  // three-new-ssr accumulates stochastic reflections over at least ACCUM_FRAMES pipeline frames per output frame
  // budget: each render() runs several pipeline frames (scenes without SSR are left unchanged). three-new-ssr-fast
  // can lower this budget via ssrFast.accumFrames (time-to-image: fewer frames at the same per-frame cost).
  const accumFrames = ssrFast?.accumFrames ?? SSR_ACCUM_FRAMES;
  const subFrames = ssrMethod === 'new' && effects.ssr ? Math.max(1, Math.ceil(accumFrames / effects.frames)) : 1;

  const handle: LiveRenderer = {
    name:
      ssgiWeighting === 'legacy'
        ? 'three-ss-legacy'
        : ssrMethod === 'new'
          ? ssrFast !== undefined
            ? 'three-new-ssr-fast'
            : 'three-new-ssr'
          : 'three-new-ssgi',
    renderer,
    get frames() {
      return frames;
    },
    render() {
      for (let i = 0; i < subFrames; i++) {
        // effect passes only advance with the node frame, which the animation loop updates once per display
        // frame: advance it for the extra pipeline frames rendered within this one
        // oxlint-disable-next-line typescript/no-explicit-any
        if (i > 0) (renderer as any)._nodes.nodeFrame.update();
        renderPipeline.render();
      }
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
