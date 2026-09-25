// three-gpu-pathtracer: WebGLRenderer + WebGLPathTracer ground truth of the same scene objects.
import {
  BufferAttribute,
  Color,
  CubeCamera,
  HalfFloatType,
  ShaderChunk,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from 'three';
import type { Mesh, Object3D } from 'three';
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

// three-gpu-pathtracer's mergeGeometries drops RGB vertex colors when merging them with RGBA ones (the default it
// gives meshes without colors; its itemSize 3→4 branch copies the wrong way), leaving them black: widen them to RGBA.
export function widenVertexColors(scene: Object3D): void {
  scene.traverse((object) => {
    const color = (object as Mesh).geometry?.getAttribute('color');
    if (!color || color.itemSize !== 3) return;
    const rgba = new Float32Array(color.count * 4).fill(1);
    for (let i = 0; i < color.count; i++) rgba.set([color.getX(i), color.getY(i), color.getZ(i)], i * 4);
    (object as Mesh).geometry.setAttribute('color', new BufferAttribute(rgba, 4));
  });
}

export async function createPathTracerRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  { width, height }: RendererOptions,
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

  widenVertexColors(scene);

  // primary rays that miss must show the gradient composited in the blit: render them as black and transparent
  if (setup.gradientBackground) scene.background = new Color(0x000000);

  const pathTracer = new WebGLPathTracer(renderer);
  pathTracer.renderDelay = 0;
  pathTracer.fadeDuration = 0;
  pathTracer.minSamples = 0;
  pathTracer.rasterizeScene = false;
  pathTracer.dynamicLowRes = false;
  pathTracer.tiles.set(1, 1); // one renderSample() is one full-frame sample
  pathTracer.bounces = PATHTRACER_BOUNCES;
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
