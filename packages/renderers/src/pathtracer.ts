// three-gpu-pathtracer: WebGLRenderer + WebGLPathTracer ground truth of the same scene objects.
import {
  Color,
  CubeCamera,
  HalfFloatType,
  ShaderChunk,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
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

export async function createPathTracerRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  { width, height, pass }: RendererOptions,
): Promise<LiveRenderer> {
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
