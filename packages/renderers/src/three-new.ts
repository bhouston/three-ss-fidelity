// three-new: WebGPURenderer + RenderPipeline built like the three.js fork's webgpu_postprocessing_ssgi.html, with
// solid-angle SSGI (vendored ssgi-fast/SSGINode.js) and real-time stochastic SSR (vendored ssr/NewSSRNode.js),
// resolved with TRAA. See docs/THREE-NEW.md.
import { BackSide, LinearSRGBColorSpace, NoToneMapping } from 'three';
import {
  MeshBasicNodeMaterial,
  PMREMGenerator,
  RenderPipeline,
  RGBFormat,
  UnsignedByteType,
  UnsignedInt101111Type,
  WebGPURenderer,
} from 'three/webgpu';
import {
  builtinGIContext,
  color,
  context,
  float,
  metalness,
  mix,
  mrt,
  normalView,
  packNormalToRGB,
  pass,
  perspectiveDepthToViewZ,
  reference,
  roughness,
  rtt,
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
import { previousFrameGeometry, temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ssgi } from './ssgi-fast/SSGINode.js';
import { newSSR } from './ssr/NewSSRNode.js';
import type { SceneEffects, SceneSetup } from '@ss-fidelity/scenes';
import type { LiveRenderer, PassName, RendererOptions } from './types.js';

/** SSGINode's AO frames: the temporal denoiser converges at ~64 (see PLAN.md). */
const AO_FRAMES = 128;

/** The screen-space pipeline settings of a pass (shared with three-current.ts). */
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

/**
 * NewSSRNode settings (see docs/history/SSR_IMPROVEMENTS.md for the tracing rounds, SSR_TEMPORAL.md for the real-time filter):
 * - clipRaysToScreen: the screen-exit ray parameter once per ray, not a bounds test per march step (bit-identical)
 * - secondBounceRoughnessCutoff: at or above this hit roughness, the second bounce reads the prefiltered environment
 * - quality / secondBounceQuality: march step density of the primary / second bounce (binary refinement still runs)
 * - hiZ: hierarchical min-depth traversal instead of the dense march
 * - silhouetteFetch: read hits of hidden surfaces from inside the object, not its anti-aliased silhouette
 */
const SSR_OPTIONS = {
  clipRaysToScreen: true,
  binaryRefineSteps: 8,
  secondBounceRoughnessCutoff: 0.8,
  quality: 0.6,
  secondBounceQuality: 0.4,
  hiZ: true,
  silhouetteFetch: true,
};

function createPipeline(
  renderer: WebGPURenderer,
  setup: SceneSetup,
  aoOutput: boolean,
  ssrDebug: RendererOptions['ssrDebug'],
): RenderPipeline {
  const { scene, camera, effects } = setup;
  const resolutionScale = effects.resolutionScale ?? 1;
  // rtt() render targets (giRadianceSource below) aren't tracked by RenderPipeline's own dispose(), so they're
  // collected here and disposed explicitly in createThreeNewRenderer's dispose() (see docs/history/SSGI_FAST.md).
  const rttDisposables: AnyNode[] = [];

  const renderPipeline = new RenderPipeline(renderer);
  (renderPipeline as AnyNode).rttDisposables = rttDisposables;

  // pre-pass: SSGI/SSR run before the scene pass so their results can light the materials, which means depth,
  // normals and velocity have to come from a separate pass. It also writes transparent surfaces (e.g. steampunk's
  // opaque-but-transparent-flagged Lense_Casing): they read their reflections from the SSR target at their own
  // pixels, so they need depth/normal/roughness there
  const prePass = pass(scene, camera);
  prePass.name = 'Pre-Pass';
  prePass.transparent = true;
  prePass.setMRT(
    mrt({
      output: packNormalToRGB(normalView),
      velocity,
      // the texture-mapped material properties
      metalRoughness: vec2(metalness, roughness),
      // SSR re-evaluates the specular of its hits for the reflected ray's direction (see NewSSRNode.js)
      specular: vec4(specularColorBlended, specularF90),
    }),
  );
  const prePassNormal: AnyNode = prePass.getTextureNode();
  const prePassDepth: AnyNode = prePass.getTextureNode('depth');
  const prePassVelocity: AnyNode = prePass.getTextureNode('velocity');
  prePass.getTexture('metalRoughness').type = UnsignedByteType;
  const prePassMetalRoughness: AnyNode = prePass.getTextureNode('metalRoughness').sample(screenUV);
  const sceneNormal = sample((uv: AnyNode) => unpackRGBToNormal(prePassNormal.sample(uv)));

  // scene pass, anti-aliased with TRAA; the effects sample its previous (anti-aliased) frame reprojected to the
  // current one. Once the view is still, TRAA's history becomes an exact running mean (render() below restarts it
  // when an object moves).
  const scenePass = pass(scene, camera);
  const aaPass: AnyNode = traa(scenePass, prePassDepth, prePassVelocity, camera);
  aaPass.progressive = true;
  (renderPipeline as AnyNode).progressiveTRAA = aaPass;
  const previousFrame = texture(aaPass.getTextureNode().value);
  const previousRadiance = sample((uv: AnyNode) =>
    previousFrame.sample(uv.sub(prePassVelocity.sample(uv).xy.mul(vec2(0.5, -0.5)))),
  );

  const temporal = effects.temporalDenoise;
  const sharedPreviousFrame = temporal ? previousFrameGeometry(prePassDepth, prePassNormal) : null;
  const temporalDenoise = (signal: AnyNode): AnyNode => {
    const reprojected = (temporalReproject as AnyNode)(signal, prePassDepth, prePassNormal, prePassVelocity, camera, {
      previousFrameGeometry: sharedPreviousFrame,
    });
    const denoised = (recurrentDenoise as AnyNode)(reprojected, camera, {
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
    // SSGINode samples the radiance ~32 times per pixel, each a dependent velocity + previous-frame fetch pair;
    // reprojecting it once into an RG11B10 texture (at SSGI's resolution) replaces that with one fetch per sample
    const giRadianceSource: AnyNode = rtt(previousRadiance.sample(screenUV), null, null, {
      resolutionScale,
      type: UnsignedInt101111Type,
      format: RGBFormat,
    });
    rttDisposables.push(giRadianceSource);
    giPass = (ssgi as AnyNode)(giRadianceSource, prePassDepth, sceneNormal, camera);
    giPass.loopInvariantInitialStep = true;
    giPass.useSolidAngleWeighting.value = true;
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
  let debugOutput: AnyNode = null;
  if (effects.ssr) {
    const params = effects.ssr;
    // depth of the nearest back faces, so SSR knows how thick each solid actually is
    const backPass = pass(scene, camera);
    backPass.name = 'Back-Face Depth Pre-Pass';
    backPass.transparent = true; // like the pre-pass
    backPass.overrideMaterial = new MeshBasicNodeMaterial({ side: BackSide });

    const ssrPass: AnyNode = (newSSR as AnyNode)(previousRadiance, prePassDepth, sceneNormal, {
      metalnessNode: prePassMetalRoughness.r,
      roughnessNode: prePassMetalRoughness.g,
      outputRadiance: true,
      environmentNode: scene.environment ?? undefined,
      camera,
      // stochastic VNDF rays over the full GGX lobe for every material (dielectrics too), one pipeline frame per
      // rendered frame, converged by NewSSRNode's own spatial + temporal filter
      reflectNonMetals: true,
      stochastic: true,
      temporalFilter: true,
      velocityNode: prePassVelocity,
      debugView: ssrDebug ?? null,
      backDepthNode: backPass.getTextureNode('depth'),
      hitMaterialNode: prePass.getTextureNode('metalRoughness'),
      hitSpecularNode: prePass.getTextureNode('specular'),
      ...SSR_OPTIONS,
    });
    if (scene.environment) ssrPass.environmentIntensity.value = scene.environmentIntensity;
    // NewSSRNode drops the fork's distance-fade/hit-rejection use of maxDistance in radiance mode, so maxDistance
    // is only a ray-length budget: a large, scene-independent value instead of the scene's artistic cutoff
    ssrPass.maxDistance.value = camera.far * 2;
    ssrPass.quality.value = SSR_OPTIONS.quality;
    if (params.blurQuality !== undefined) ssrPass.blurQuality = params.blurQuality;
    if (params.intensity !== undefined) ssrPass.intensity.value = params.intensity;
    if (params.thickness !== undefined) ssrPass.thickness.value = params.thickness;
    ssrPass.binaryRefine = true;
    ssrPass.resolutionScale = resolutionScale;
    // unbiased: full VNDF lobe, no luminance clamp, no screen-edge fade (a hit is a hit; rays leaving the screen
    // fall back to the environment), fresh samples every frame
    ssrPass.mirrorBias.value = 0;
    ssrPass.maxLuminance.value = 1e9;
    ssrPass.screenEdgeFade.value = 0;
    ssrPass.useTemporalFiltering = true;

    reflections = ssrPass.getTextureNode().sample(screenUV).rgb;
    if (ssrDebug) {
      // the trace pass's own target (the debug view), while the reflections and the scene pass still run so the
      // next frame's hits read a real scene color
      debugOutput = vec4(texture(ssrPass._ssrRenderTarget.textures[0]).sample(screenUV).rgb, 1)
        .add(reflections.mul(0))
        .add(aaPass.mul(0));
    }
  }

  // builtinRadianceContext leaves transparent-flagged materials on the environment map. The pre-passes include them
  // (steampunk's opaque Lense_Casing), so they take the SSR radiance too.
  const radiance = !reflections
    ? null
    : (context as AnyNode)(null, {
        getRadiance: (inputNode: AnyNode) => (inputNode !== null ? inputNode.add(reflections) : reflections),
      });
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
    scenePass.contextNode = (builtinGIContext as AnyNode)(ao, gi, radiance);
  } else if (radiance) {
    scenePass.contextNode = radiance;
  }

  renderPipeline.outputNode = debugOutput ?? aaPass;
  return renderPipeline;
}

export async function createThreeNewRenderer(
  canvas: HTMLCanvasElement,
  sceneSetup: SceneSetup,
  { width, height, pass: renderPass, trackTimestamp = false, ssrDebug }: RendererOptions,
): Promise<LiveRenderer> {
  const setup = { ...sceneSetup, effects: passEffects(sceneSetup, renderPass) };
  const { scene, camera, effects } = setup;
  const renderer = new WebGPURenderer({ canvas, antialias: false, trackTimestamp });
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

  const renderPipeline = createPipeline(renderer, setup, renderPass === 'ao', ssrDebug);
  const progressive = (renderPipeline as AnyNode).progressiveTRAA;
  let frames = 0;
  let sceneSignature = 0;

  const handle: LiveRenderer = {
    name: 'three-new',
    renderer,
    get frames() {
      return frames;
    },
    render() {
      if (progressive) {
        // ponytail: sums every world matrix per frame, O(objects); a scene version counter if scenes get big
        let signature = 0;
        setup.scene.traverse((o) => o.matrixWorld.elements.forEach((e, i) => (signature += e * (i + 1))));
        if (signature !== sceneSignature) progressive.resetAccumulation();
        sceneSignature = signature;
      }
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
      // RenderPipeline.dispose() and Renderer.dispose() don't reach the rtt() render targets (see docs/history/SSGI_FAST.md)
      for (const disposable of (renderPipeline as AnyNode).rttDisposables) disposable.dispose();
      renderPipeline.dispose();
      renderer.dispose();
    },
  };
  handle.setSize(width, height);
  return handle;
}
