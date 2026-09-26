import { createRenderer } from '@ss-fidelity/renderers';
import { createBrowserSceneContext, getScene } from '@ss-fidelity/scenes';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PassName, RendererName } from '#/lib/scenes';

/** Where `submodules/three.js/examples/` is served (see `routes/three-examples/$.ts`); scenes load glTF / Draco from here. */
export const THREE_EXAMPLES_BASE_URL = '/three-examples/';

/** Path tracing stops accumulating here to spare the GPU; orbiting restarts it. */
export const MAX_PATHTRACER_SAMPLES = 1024;

export interface LiveRenderOptions {
  canvas: HTMLCanvasElement;
  sceneName: string;
  renderer: RendererName;
  pass: PassName;
  /** Called after every rendered frame with the pipeline frame count (screen space) or accumulated samples (pathtracer). */
  onFrame: (frames: number) => void;
}

export interface LiveRender {
  dispose(): void;
}

/** The only place the viewer talks to `@ss-fidelity/scenes` / `@ss-fidelity/renderers`. Rejects on failure. */
export async function startLiveRender({
  canvas,
  sceneName,
  renderer,
  pass,
  onFrame,
}: LiveRenderOptions): Promise<LiveRender> {
  const definition = getScene(sceneName);
  // A fresh setup per renderer: the adapters mutate the scene.
  const setup = await definition.create(createBrowserSceneContext(THREE_EXAMPLES_BASE_URL));
  const live = await createRenderer(renderer, canvas, setup, {
    width: definition.width,
    height: definition.height,
    pass,
  });

  const controls = new OrbitControls(setup.camera, canvas);
  controls.target.copy(setup.target);
  controls.update();
  controls.addEventListener('change', () => live.setCamera(setup.camera));

  // Both screen-space methods are temporal (TRAA / denoise); the pathtracer stops once converged enough.
  let frame = requestAnimationFrame(function tick() {
    if (renderer !== 'three-gpu-pathtracer' || live.frames < MAX_PATHTRACER_SAMPLES) {
      live.render();
      onFrame(live.frames);
    }
    frame = requestAnimationFrame(tick);
  });

  return {
    dispose() {
      cancelAnimationFrame(frame);
      controls.dispose();
      live.dispose();
    },
  };
}
