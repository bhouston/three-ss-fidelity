import { createReporter } from 'performance-kit-reporter';
import type { SceneSetup } from '@ss-fidelity/scenes';
import type { LiveRenderer } from '@ss-fidelity/renderers';
import type { FrameContext } from '@ss-fidelity/runtime';

const reporter = createReporter();
let live: LiveRenderer | undefined;
let setup: SceneSetup | undefined;
let animation = 0;
let canvas: HTMLCanvasElement | undefined;
let cleanupScene: ((setup: SceneSetup) => void) | undefined;
let complete: (() => Promise<void>) | undefined;
let draw: (() => void) | undefined;

reporter.onStart(async ({ params }) => {
  reporter.phaseStart('load');
  const [scenes, renderers, runtime, { performanceConfiguration }] = await Promise.all([
    import('@ss-fidelity/scenes'),
    import('@ss-fidelity/renderers'),
    import('@ss-fidelity/runtime'),
    import('./performance-config'),
  ]);
  const config = performanceConfiguration(params ?? {});
  const previousRandom = Math.random;
  try {
    Math.random = runtime.seededRandom(config.seed);
    setup = await scenes.getScene(config.scene).create(scenes.createBrowserSceneContext('/'));
  } finally {
    Math.random = previousRandom;
  }
  cleanupScene = scenes.disposeSceneSetup;
  reporter.phaseEnd('load');
  reporter.phaseStart('process');
  canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  document.body.replaceChildren(canvas);
  type AdapterInfo = { vendor?: string; architecture?: string; description?: string };
  const navigatorGPU = (
    navigator as unknown as { gpu?: { requestAdapter(...args: unknown[]): Promise<{ info?: AdapterInfo } | null> } }
  ).gpu;
  const requestAdapter = navigatorGPU?.requestAdapter;
  let adapterInfo: AdapterInfo | undefined;
  if (navigatorGPU && requestAdapter)
    navigatorGPU.requestAdapter = async (...args) => {
      const adapter = await requestAdapter.apply(navigatorGPU, args);
      if (adapter?.info)
        adapterInfo = {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          description: adapter.info.description,
        };
      return adapter;
    };
  try {
    live = await renderers.createRenderer(config.renderer, canvas, setup, {
      width: config.width,
      height: config.height,
      hierarchyExperiment: config.experiment,
    });
  } finally {
    if (navigatorGPU && requestAdapter) navigatorGPU.requestAdapter = requestAdapter;
  }
  const current = live;
  const advance = renderers.createRendererFrameDriver(current.renderer);
  const orbit = config.motion === 'orbit' ? scenes.createOrbitWorkload(setup, 120, 30) : undefined;
  complete = () => renderers.completeRenderer(current.renderer);
  // Read the adapter selected by the renderer; probing another adapter can misidentify software fallbacks.
  const gpu = reporter.gpu.attachThree(current.renderer as Parameters<typeof reporter.gpu.attachThree>[0]);
  reporter.environment({
    api: gpu.api,
    canvasSize: { width: config.width, height: config.height },
    gpuAdapter: adapterInfo,
    gpuTimestampsAvailable: gpu.available,
  });
  let frameIndex = 0;
  draw = () => {
    const frame: FrameContext = {
      index: frameIndex++,
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      phase: 'measure',
    };
    const token = reporter.frameBegin({ animationTime: frame.timeSeconds });
    gpu.begin(token);
    advance(frame);
    if (orbit) {
      orbit(frame.index);
      current.setCamera(setup!.camera);
    }
    current.render(frame);
    gpu.end();
    reporter.frameEnd(token);
  };
  reporter.phaseEnd('process');
  reporter.phaseStart('compile');
  // Compile the entire post-processing graph, including lazily built passes, during init.
  draw();
  await complete();
  reporter.phaseEnd('compile');
  reporter.ready();
  const tick = () => {
    try {
      draw!();
      animation = requestAnimationFrame(tick);
    } catch (error) {
      reporter.fail(error);
    }
  };
  animation = requestAnimationFrame(tick);
});
reporter.onCapture(async () => {
  await complete?.();
  draw?.();
  await complete?.();
  if (!canvas) throw new Error('Renderer has no canvas');
  return canvas;
});
window.addEventListener(
  'pagehide',
  () => {
    cancelAnimationFrame(animation);
    reporter.dispose();
    live?.dispose();
    if (setup) cleanupScene?.(setup);
  },
  { once: true },
);
