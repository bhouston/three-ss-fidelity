// three-new: WebGPURenderer + RenderPipeline built like the three.js fork's webgpu_postprocessing_ssgi.html, with
// solid-angle SSGI (vendored ssgi-fast/SSGINode.js) and real-time stochastic SSR (vendored ssr/NewSSRNode.js),
// resolved with TRAA. See docs/THREE-NEW.md.
import { BackSide, LinearMipmapLinearFilter } from 'three';
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
  vec4,
  velocity,
} from 'three/tsl';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';
import { previousFrameGeometry, temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { traa } from './traa/TRAANode.js';
import { ssgi } from './ssgi-fast/SSGINode.js';
import { bilateralUpsample } from './ssgi-fast/bilateralUpsample.js';
import { newSSR } from './ssr/NewSSRNode.js';
import { BoxProjectedProbe } from './box-projected.js';
import type { SceneSetup } from '@ss-fidelity/scenes';
import { ssgiWorkExperiments } from './types.js';
import type { LiveRenderer, RendererOptions, SSGIWorkExperiment } from './types.js';
import { VirtualPointLightGI } from './vpl/VirtualPointLightGI.js';
import { ProgressiveLightBake } from './light-bake/ProgressiveLightBake.js';
import { bakeProbeGrid } from './probe-grid.js';
import { createMirrors, findMirrorPlanes } from './mirror/mirrors.js';
import type { Mirrors } from './mirror/mirrors.js';
import { MirrorAwareVelocityNode } from './mirror/velocity.js';
import { configureRenderer, prepareScene, setRenderSize } from './helpers.js';

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
  ssrDebug: RendererOptions['ssrDebug'],
  hierarchyExperiment: RendererOptions['hierarchyExperiment'],
  ssrTemporalProfile: RendererOptions['ssrTemporalProfile'],
  useProbes = false,
  boxRadiance: AnyNode = null,
  mirrorVelocity = false,
): RenderPipeline {
  const { scene, camera, effects } = setup;
  const resolutionScale = effects.resolutionScale ?? 1;
  const work: SSGIWorkExperiment | undefined =
    hierarchyExperiment && Object.hasOwn(ssgiWorkExperiments, hierarchyExperiment)
      ? ssgiWorkExperiments[hierarchyExperiment as keyof typeof ssgiWorkExperiments]
      : undefined;
  const combined = hierarchyExperiment === 'hierarchy-combined' || work !== undefined;
  const reducedGI = hierarchyExperiment === 'ssgi-half' || hierarchyExperiment === 'ssgi-third';
  const giResolutionScale =
    resolutionScale / (hierarchyExperiment === 'ssgi-half' ? 2 : hierarchyExperiment === 'ssgi-third' ? 3 : 1);
  const giRadianceMips = combined || hierarchyExperiment === 'ssgi-radiance-mips';
  const ssrRadianceMips = combined || hierarchyExperiment === 'ssr-radiance-mips';
  const tightHiZ = combined || hierarchyExperiment === 'ssr-hiz-tight';
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
      // mirror pixels move like their reflected content, not like the mirror surface
      velocity: mirrorVelocity ? new MirrorAwareVelocityNode() : velocity,
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
  // TAA accumulation/validation background: Yang, Liu & Salvi, A Survey of Temporal Antialiasing
  // Techniques (2020): https://research.nvidia.com/labs/rtr/publication/yang2020survey/
  // Resolve the beauty after the dedicated SSR denoiser; TAA alone is not the reflection denoiser.
  const aaPass: AnyNode = traa(scenePass, prePassDepth, prePassVelocity, camera);
  aaPass.progressive = true;
  (renderPipeline as AnyNode).progressiveTRAA = aaPass;
  const previousFrame = texture(aaPass.getTextureNode().value);
  const previousRadiance = sample((uv: AnyNode) =>
    previousFrame.sample(uv.sub(prePassVelocity.sample(uv).xy.mul(vec2(0.5, -0.5)))),
  );

  // AO/GI use the fork's diffuse reprojection and recurrent edge-aware filter.
  // REBLUR-derived helpers are credited in RecurrentDenoiseNode (https://github.com/NVIDIA-RTX/NRD).
  // See docs/SCREEN_SPACE_ALGORITHMS.md: this is not an exact NRD or SVGF port.
  const temporal = effects.temporalDenoise;
  const sharedPreviousFrame = temporal ? previousFrameGeometry(prePassDepth, prePassNormal) : null;
  const temporalDenoise = (signal: AnyNode, scale = resolutionScale): AnyNode => {
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
    reprojected.resolutionScale = denoised.resolutionScale = scale;
    return denoised.getTextureNode();
  };

  let giPass: AnyNode = null;
  let sharedRadiance: AnyNode = null;
  if (effects.ssgi && !useProbes) {
    // SSGINode samples the radiance ~32 times per pixel, each a dependent velocity + previous-frame fetch pair;
    // reprojecting it once into an RG11B10 texture (at SSGI's resolution) replaces that with one fetch per sample
    const giRadianceSource: AnyNode = rtt(previousRadiance.sample(screenUV), null, null, {
      resolutionScale: giResolutionScale,
      type: UnsignedInt101111Type,
      format: RGBFormat,
    });
    if (giRadianceMips) {
      giRadianceSource.value.generateMipmaps = true;
      giRadianceSource.value.minFilter = LinearMipmapLinearFilter;
    }
    rttDisposables.push(giRadianceSource);
    giPass = (ssgi as AnyNode)(giRadianceSource, prePassDepth, sceneNormal, camera);
    // SSR's LOD is expressed in full-resolution pixels. Share only when GI's source has that resolution;
    // sharing a reduced-resolution chain would change its footprint and lose fine reflection detail.
    if (combined && resolutionScale === 1) sharedRadiance = giRadianceSource;
    giPass.radianceMips = giRadianceMips;
    giPass.loopInvariantInitialStep = true;
    giPass.useSolidAngleWeighting.value = true;
    giPass.earlyExit = work?.earlyExit ?? false;
    giPass.reuseDuplicateTexels = work?.reuseDuplicateTexels ?? false;
    giPass.sliceCount.value = Math.max(1, Math.floor(effects.ssgi.sliceCount * (work?.sliceScale ?? 1)));
    giPass.stepCount.value = Math.max(1, Math.floor(effects.ssgi.stepCount * (work?.stepScale ?? 1)));
    giPass.giIntensity.value = effects.ssgi.giIntensity;
    giPass.useTemporalFiltering = temporal;
    giPass.resolutionScale = giResolutionScale;
    const { radius, thickness, aoIntensity, useScreenSpaceSampling } = effects.ssgi;
    if (radius !== undefined) giPass.radius.value = radius;
    if (thickness !== undefined) giPass.thickness.value = thickness;
    if (aoIntensity !== undefined) giPass.aoIntensity.value = aoIntensity;
    if (useScreenSpaceSampling !== undefined) giPass.useScreenSpaceSampling.value = useScreenSpaceSampling;
  }

  let reflections: AnyNode = null;
  let debugOutput: AnyNode = null;
  // box-projected mode takes every specular reflection from the captured cube map instead of SSR
  if (effects.ssr && !boxRadiance) {
    const params = effects.ssr;
    // depth of the nearest back faces, so SSR knows how thick each solid actually is
    const backPass = pass(scene, camera);
    backPass.name = 'Back-Face Depth Pre-Pass';
    backPass.transparent = true; // like the pre-pass
    backPass.overrideMaterial = new MeshBasicNodeMaterial({ side: BackSide });

    // A mipmapped, reprojected source costs an extra pass for SSR; benchmark that cost too.
    let ssrRadiance: AnyNode = previousRadiance;
    if (sharedRadiance) {
      ssrRadiance = sharedRadiance;
    } else if (ssrRadianceMips) {
      ssrRadiance = rtt(previousRadiance.sample(screenUV), null, null, {
        type: UnsignedInt101111Type,
        format: RGBFormat,
        generateMipmaps: true,
        minFilter: LinearMipmapLinearFilter,
      });
      rttDisposables.push(ssrRadiance);
    }
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
      temporalProfile:
        ssrTemporalProfile ??
        (hierarchyExperiment === 'ssr-temporal-validated'
          ? 'validated'
          : hierarchyExperiment === 'ssr-temporal-gaussian'
            ? 'gaussian'
            : 'baseline'),
      velocityNode: prePassVelocity,
      debugView: ssrDebug ?? null,
      backDepthNode: backPass.getTextureNode('depth'),
      hitMaterialNode: prePass.getTextureNode('metalRoughness'),
      hitSpecularNode: prePass.getTextureNode('specular'),
      ...SSR_OPTIONS,
      tightHiZ,
      radianceMipNode: ssrRadianceMips ? ssrRadiance : null,
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
  const radiance = boxRadiance
    ? (context as AnyNode)(null, {
        // replaces the environment radiance; transparent materials keep it
        getRadiance: (inputNode: AnyNode, { material }: AnyNode) => (material.transparent ? inputNode : boxRadiance),
      })
    : !reflections
      ? null
      : (context as AnyNode)(null, {
          getRadiance: (inputNode: AnyNode) => (inputNode !== null ? inputNode.add(reflections) : reflections),
        });
  if (giPass) {
    const aoSignal = temporal ? temporalDenoise(giPass.getAONode(), giResolutionScale) : giPass.getAONode();
    const giSignal = temporal ? temporalDenoise(giPass.getGINode(), giResolutionScale) : giPass.getGINode();
    let ao: AnyNode = aoSignal.sample(screenUV).r;
    let gi: AnyNode = giSignal.sample(screenUV).rgb;
    if (reducedGI) {
      // Material lighting samples this many times, so reconstruct once in a full-size packed target.
      const reconstructed: AnyNode = rtt(bilateralUpsample(giSignal, aoSignal, prePassDepth, prePassNormal, camera));
      reconstructed.name = 'SSGI Bilateral Upsample';
      rttDisposables.push(reconstructed);
      ao = reconstructed.sample(screenUV).a;
      gi = reconstructed.sample(screenUV).rgb;
    }
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
  {
    width,
    height,
    trackTimestamp = false,
    ssrDebug,
    hierarchyExperiment,
    ssrTemporalProfile,
    progressiveProbes,
  }: RendererOptions,
  probeMode?: 'light-probe' | 'light-probe-ddgi' | 'light-bake' | 'vpl' | 'vpl-mirror' | 'vpl-box-projected',
): Promise<LiveRenderer> {
  const useProbes = probeMode !== undefined;
  const isVpl = probeMode?.startsWith('vpl') ?? false;
  const setup = sceneSetup;
  const { camera, effects } = setup;
  const renderer = new WebGPURenderer({ canvas, antialias: false, trackTimestamp });
  renderer.shadowMap.enabled = true;
  configureRenderer(renderer, effects);
  await renderer.init();

  const releaseScene = prepareScene(setup, {
    createGradient: ({ center, edge }) => screenUV.distance(0.5).remap(0, 0.5).mix(color(center), color(edge)),
    bakeEnvironment(environment) {
      const generator = new PMREMGenerator(renderer);
      try {
        return generator.fromScene(environment.scene, environment.sigma);
      } finally {
        generator.dispose();
      }
    },
  });

  let releaseProbes: (() => void) | undefined;
  // Set only while a progressive probe bake is in flight or done; undefined when baking is not progressive.
  let probeProgress: number | undefined;
  let probeDirty = false;
  let probeError: unknown;
  let boxProbe: BoxProjectedProbe | undefined;
  let mirrors: Mirrors | undefined;
  let baker: ProgressiveLightBake | undefined;
  const createSurfaceLighting = () =>
    isVpl
      ? new VirtualPointLightGI(renderer, setup.scene, {
          mirrors: probeMode === 'vpl-mirror' ? findMirrorPlanes(setup.scene) : [],
        })
      : new ProgressiveLightBake(renderer, setup.scene);
  let renderPipeline: RenderPipeline;
  try {
    if (probeMode === 'light-bake' || isVpl) baker = createSurfaceLighting();
    if (useProbes && !baker && effects.ssgi)
      releaseProbes = await bakeProbeGrid(
        renderer,
        setup.scene,
        probeMode === 'light-probe-ddgi',
        progressiveProbes
          ? {
              onProgress(fraction) {
                probeProgress = fraction;
                probeDirty = true;
              },
              onError(error) {
                probeError = error;
              },
            }
          : undefined,
      );
    if (probeMode === 'vpl-box-projected') boxProbe = new BoxProjectedProbe(renderer, setup.scene);
    if (probeMode === 'vpl-mirror') mirrors = createMirrors(setup.scene);
    renderPipeline = createPipeline(
      renderer,
      setup,
      ssrDebug,
      hierarchyExperiment,
      ssrTemporalProfile,
      useProbes,
      boxProbe?.radiance,
      probeMode === 'vpl-mirror',
    );
  } catch (error) {
    boxProbe?.dispose();
    mirrors?.dispose();
    baker?.dispose();
    releaseProbes?.();
    releaseScene();
    renderer.dispose();
    throw error;
  }
  const progressive = (renderPipeline as AnyNode).progressiveTRAA;
  let frames = 0;
  let sceneSignature = 0;
  const bakeSignature = () => {
    setup.scene.updateMatrixWorld(true);
    let signature = '';
    setup.scene.traverse((object) => {
      const source = object as AnyNode;
      if (!source.isMesh && !source.isLight) return;
      signature += `${object.uuid}:${object.visible}:${object.matrixWorld.elements.join(',')};`;
      if (source.isMesh) {
        signature += `${source.geometry.uuid}:${source.geometry.attributes.position?.version}:${source.instanceMatrix?.version};`;
        for (const bone of source.skeleton?.bones ?? []) signature += bone.matrixWorld.elements.join(',');
        for (const material of Array.isArray(source.material) ? source.material : [source.material])
          signature += `${material.version}:${material.color?.getHex()}:${material.emissive?.getHex()}:${material.emissiveIntensity}:${material.metalness};`;
      }
      if (source.isLight)
        signature += `${source.intensity}:${source.color?.getHex()}:${source.distance}:${source.decay}:${source.angle}:${source.penumbra}:${source.width}:${source.height}:${source.target?.matrixWorld.elements.join(',')};`;
    });
    return signature;
  };
  let bakedSignature = baker ? bakeSignature() : '';

  const handle: LiveRenderer = {
    name: probeMode ? `three-new-${probeMode}` : 'three-new',
    renderer,
    get frames() {
      return frames;
    },
    get lightBake() {
      if (!baker && probeProgress !== undefined)
        return {
          phase: probeProgress >= 1 ? 'converged' : 'baking',
          samples: Math.round(probeProgress * 1000),
          maxSamples: 1000,
          progress: probeProgress,
        };
      return baker
        ? {
            phase: baker.phase,
            samples: baker.pass * baker.samplesPerFrame,
            maxSamples: baker.samples,
            progress: Math.min(1, (baker.pass * baker.samplesPerFrame) / baker.samples),
          }
        : undefined;
    },
    render() {
      if (probeError) throw probeError;
      if (probeDirty) {
        probeDirty = false;
        // each baked batch changes the lighting, so history from earlier frames is stale
        progressive?.resetAccumulation();
      }
      if (progressive) {
        // ponytail: sums every world matrix per frame, O(objects); a scene version counter if scenes get big
        let signature = 0;
        setup.scene.traverse((o) => o.matrixWorld.elements.forEach((e, i) => (signature += e * (i + 1))));
        if (signature !== sceneSignature) progressive.resetAccumulation();
        sceneSignature = signature;
      }
      let refreshProbe = false;
      if (baker) {
        const signature = bakeSignature();
        if (signature !== bakedSignature) {
          // Conservative invalidation: a blocker can affect distant transport, so rebuild the whole bake.
          // the baker restores the original materials and geometry, taking the mirror slots with them
          mirrors?.dispose();
          baker.dispose();
          baker = createSurfaceLighting();
          if (mirrors) mirrors = createMirrors(setup.scene);
          bakedSignature = bakeSignature();
        }
        if (baker.step()) {
          // the capture is expensive: refresh it periodically while the bake accumulates and once it converges
          refreshProbe = !!boxProbe && (baker.phase === 'converged' || baker.pass % 32 === 0);
          progressive?.resetAccumulation();
          // Initial lightMap assignment updates material versions once.
          bakedSignature = bakeSignature();
        }
      }
      renderPipeline.render();
      if (refreshProbe) boxProbe?.update();
      frames++;
    },
    setSize(w, h) {
      setRenderSize(renderer, camera, w, h);
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
    },
    dispose() {
      // RenderPipeline.dispose() and Renderer.dispose() don't reach the rtt() render targets (see docs/history/SSGI_FAST.md)
      for (const disposable of (renderPipeline as AnyNode).rttDisposables) disposable.dispose();
      renderPipeline.dispose();
      boxProbe?.dispose();
      mirrors?.dispose();
      baker?.dispose();
      releaseProbes?.();
      releaseScene();
      renderer.dispose();
    },
  };
  handle.setSize(width, height);
  return handle;
}
