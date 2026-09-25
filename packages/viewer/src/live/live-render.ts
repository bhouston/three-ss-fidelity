import { createBrowserSceneContext, getScene } from '@ss-fidelity/scenes';
import { Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RendererName } from '#/lib/scenes';

/** Where `submodules/three.js/examples/` is served (see `routes/three-examples/$.ts`); scenes load glTF / Draco from here. */
export const THREE_EXAMPLES_BASE_URL = '/three-examples/';

export interface LiveRenderOptions {
  canvas: HTMLCanvasElement;
  sceneName: string;
  renderer: RendererName;
  /** Called after every rendered frame; `samples` is the progressive sample count (frames for three-ss). */
  onFrame: (samples: number) => void;
}

export interface LiveRender {
  dispose(): void;
}

/** The only place the viewer talks to `@ss-fidelity/scenes` / `@ss-fidelity/renderers`. Rejects on failure. */
export async function startLiveRender({
  canvas,
  sceneName,
  renderer,
  onFrame,
}: LiveRenderOptions): Promise<LiveRender> {
  const definition = getScene(sceneName);
  canvas.width = definition.width;
  canvas.height = definition.height;
  const setup = await definition.create(createBrowserSceneContext(THREE_EXAMPLES_BASE_URL));
  const controls = new OrbitControls(setup.camera, canvas);
  // ponytail: orbit around the point on the view ray closest to the origin; exact for the current scenes' lookAt
  // targets (within ~0.1). Have scenes export their target if one ever isn't near that ray point.
  const { camera } = setup;
  const direction = camera.getWorldDirection(new Vector3());
  controls.target.copy(camera.position).addScaledVector(direction, -camera.position.dot(direction));
  controls.update();

  // TODO(@ss-fidelity/renderers): the renderers package API doesn't exist yet. Expected shape:
  //
  //   const { createBrowserRenderer } = await import('@ss-fidelity/renderers');
  //   const live = await createBrowserRenderer(renderer, { canvas, width: definition.width, height: definition.height, setup });
  //   controls.addEventListener('change', () => live.reset()); // restart progressive accumulation
  //   let frame = requestAnimationFrame(async function tick() {
  //     await live.render();
  //     onFrame(live.samples);
  //     frame = requestAnimationFrame(tick);
  //   });
  //   return { dispose: () => { cancelAnimationFrame(frame); controls.dispose(); live.dispose(); } };
  void onFrame;
  controls.dispose();
  throw new Error(
    `Scene loaded, but live ${renderer} rendering is not wired up yet (waiting on @ss-fidelity/renderers).`,
  );
}
