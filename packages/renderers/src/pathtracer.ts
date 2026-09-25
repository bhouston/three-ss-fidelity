// three-gpu-pathtracer: WebGLRenderer + WebGLPathTracer ground truth of the same scene objects.
import {
  Color,
  CubeCamera,
  FloatType,
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import type { Material } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { AmbientOcclusionMaterial, PathTracingSceneGenerator, WebGLPathTracer } from 'three-gpu-pathtracer';
import type { SceneSetup } from '@ss-fidelity/scenes';
import type { LiveRenderer, RendererOptions } from './types.js';

/** Path tracing bounces (three-ss accumulates bounces over frames, so give the ground truth plenty). */
export const PATHTRACER_BOUNCES = 8;

// Final blit, replacing the pathtracer's own: composites the scene's screen-space gradient background under the
// accumulated (premultiplied) radiance before tone mapping, like the raster background, then tone maps and encodes.
function createBlitMaterial(setup: SceneSetup): ShaderMaterial {
  const gradient = setup.gradientBackground;
  return new ShaderMaterial({
    defines: { GRADIENT_BACKGROUND: gradient ? 1 : 0 },
    uniforms: {
      map: { value: null },
      center: { value: gradient?.center ?? new Color() },
      edge: { value: gradient?.edge ?? new Color() },
    },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 center;
      uniform vec3 edge;
      void main() {
        ivec2 size = textureSize( map, 0 );
        vec4 radiance = texelFetch( map, ivec2( gl_FragCoord.xy ), 0 );
        #if GRADIENT_BACKGROUND
        vec2 uv = gl_FragCoord.xy / vec2( size );
        radiance.rgb += mix( center, edge, distance( uv, vec2( 0.5 ) ) / 0.5 ) * ( 1.0 - radiance.a );
        #endif
        gl_FragColor = vec4( radiance.rgb, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// The three.js fork dropped this chunk (PMREM uses cube render targets now); three-gpu-pathtracer's
// CubeToEquirectGenerator still includes it without using it.
(ShaderChunk as Record<string, string>).cube_uv_reflection_fragment ??= '';

// With one bounce, MIS-weighted environment / area light misses its BSDF-sampled half (the next ray is never traced).
// Direct lighting is therefore two bounces where the second ray only collects environment misses and light hits:
// it stops at any surface, before that surface's emission and light sampling.
const SECOND_HIT_ANCHOR = 'if ( hitType == NO_HIT ) {';
const STOP_AT_SECOND_HIT = 'if ( hitType == SURFACE_HIT && ! state.firstRay && ! state.transmissiveRay ) break;';

/** Patches a PhysicalPathTracingMaterial to trace direct lighting only (use with 2 bounces). */
export function traceDirectOnly(material: { fragmentShader: string; needsUpdate: boolean }): void {
  const parts = material.fragmentShader.split(SECOND_HIT_ANCHOR);
  if (parts.length !== 2) throw new Error('three-gpu-pathtracer shader changed: cannot patch direct-only tracing');
  material.fragmentShader = parts.join(`${STOP_AT_SECOND_HIT}\n${SECOND_HIT_ANCHOR}`);
  material.needsUpdate = true;
}

// ao: three-gpu-pathtracer's AmbientOcclusionMaterial (cosine-weighted hemisphere rays against the scene BVH; a ray
// hitting within `radius` occludes) rasterized over the baked scene geometry, one ray per pixel per frame, averaged.
// Pixel centres, no jitter, like three-ss's AO output.
function createAORenderer(canvas: HTMLCanvasElement, setup: SceneSetup, width: number, height: number): LiveRenderer {
  const { scene, camera } = setup;
  const renderer = new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.setClearColor(0xffffff, 1); // background: unoccluded

  // three-ss's pre-pass (the AO depth/normals) skips transparent objects, so they don't occlude here either
  scene.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    if ([material ?? []].flat().some((m) => m.transparent)) object.visible = false;
  });
  scene.updateMatrixWorld(true);
  const { bvh, geometry } = new PathTracingSceneGenerator(scene).generate();

  const aoMaterial = new AmbientOcclusionMaterial({ radius: setup.aoRadius });
  // oxlint-disable-next-line typescript/no-explicit-any -- MaterialBase uniform accessors are untyped
  const ao = aoMaterial as any;
  ao.bvh.updateFrom(bvh);
  ao.setDefine('SAMPLES', 1);
  const aoScene = new Scene().add(new Mesh(geometry, aoMaterial));

  const sampleTarget = new WebGLRenderTarget(width, height, { type: FloatType });
  const accumTarget = new WebGLRenderTarget(width, height, { type: FloatType, depthBuffer: false });
  const blend = new FullScreenQuad(new MeshBasicMaterial({ transparent: true }));
  const blendMaterial = blend.material as MeshBasicMaterial;
  let frames = 0;

  const handle: LiveRenderer = {
    name: 'three-gpu-pathtracer',
    renderer,
    get frames() {
      return frames;
    },
    render() {
      ao.seed++;
      renderer.setRenderTarget(sampleTarget);
      renderer.render(aoScene, camera);
      // running mean: blend each sample in with weight 1 / n
      frames++;
      renderer.setRenderTarget(accumTarget);
      renderer.autoClear = false;
      blendMaterial.map = sampleTarget.texture;
      blendMaterial.opacity = 1 / frames;
      blend.render(renderer);
      renderer.autoClear = true;
      renderer.setRenderTarget(null);
      blendMaterial.map = accumTarget.texture;
      blendMaterial.opacity = 1;
      blend.render(renderer);
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      sampleTarget.setSize(w, h);
      accumTarget.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      frames = 0;
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
      frames = 0;
    },
    dispose() {
      blend.dispose();
      blendMaterial.dispose();
      aoMaterial.dispose();
      sampleTarget.dispose();
      accumTarget.dispose();
      renderer.dispose();
    },
  };
  handle.setSize(width, height);
  return handle;
}

export async function createPathTracerRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  { width, height, pass }: RendererOptions,
): Promise<LiveRenderer> {
  if (pass === 'ao') return createAORenderer(canvas, setup, width, height);
  const { scene, camera, effects } = setup;
  const renderer = new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.toneMapping = effects.toneMapping;
  renderer.toneMappingExposure = effects.toneMappingExposure;

  // the raster PMREM (RoomEnvironment etc.) as a plain cube map, which the pathtracer converts to an equirect
  let cubeTarget: WebGLCubeRenderTarget | null = null;
  if (setup.environment) {
    cubeTarget = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cubeCamera = new CubeCamera(0.1, 100, cubeTarget);
    cubeCamera.update(renderer, setup.environment.scene);
    scene.environment = cubeTarget.texture;
  }

  // primary rays that miss must show the gradient composited in the blit: render them as black and transparent
  if (setup.gradientBackground) scene.background = new Color(0x000000);

  const pathTracer = new WebGLPathTracer(renderer);
  pathTracer.renderDelay = 0;
  pathTracer.fadeDuration = 0;
  pathTracer.minSamples = 0;
  pathTracer.rasterizeScene = false;
  pathTracer.dynamicLowRes = false;
  pathTracer.tiles.set(1, 1); // one renderSample() is one full-frame sample
  pathTracer.bounces = pass === 'direct' ? 2 : PATHTRACER_BOUNCES;
  // oxlint-disable-next-line typescript/no-explicit-any -- internal PathTracingRenderer material
  if (pass === 'direct') traceDirectOnly((pathTracer as any)._pathTracer.material);
  pathTracer.filterGlossyFactor = 0; // unbiased

  const blit = new FullScreenQuad(createBlitMaterial(setup));
  pathTracer.renderToCanvasCallback = (target: { texture: unknown }) => {
    (blit.material as ShaderMaterial).uniforms.map!.value = target.texture;
    blit.render(renderer);
  };

  const handle: LiveRenderer = {
    name: 'three-gpu-pathtracer',
    renderer,
    get frames() {
      return pathTracer.samples;
    },
    render() {
      pathTracer.renderSample();
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      pathTracer.updateCamera();
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
      pathTracer.updateCamera();
    },
    dispose() {
      blit.dispose();
      blit.material.dispose();
      pathTracer.dispose();
      cubeTarget?.dispose();
      renderer.dispose();
    },
  };

  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  pathTracer.setScene(scene, camera);
  if (setup.gradientBackground) {
    // oxlint-disable-next-line typescript/no-explicit-any -- internal PathTracingRenderer material
    (pathTracer as any)._pathTracer.material.backgroundAlpha = 0;
  }
  return handle;
}
