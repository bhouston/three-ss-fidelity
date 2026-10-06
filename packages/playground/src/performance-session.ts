import type { SceneInstance } from '@ss-fidelity/scenes';
import type { LiveRenderer } from '@ss-fidelity/renderers';
import type { FrameContext } from '@ss-fidelity/runtime';
import type { Reporter } from 'fidelity-kit/browser';
import type { NavigationOptions } from './performance-navigation';

export type PerformanceReporter = Pick<
  Reporter,
  'phaseStart' | 'phaseEnd' | 'environment' | 'frameBegin' | 'frameEnd' | 'convergence' | 'ready'
>;

export async function createPerformanceSession(
  params: Record<string, unknown>,
  reporter: PerformanceReporter,
  host: HTMLElement,
  interactive = false,
  navigationOptions?: NavigationOptions,
) {
  let live: LiveRenderer | undefined;
  let setup: SceneInstance | undefined;
  let navigation: { update(deltaSeconds: number): void; dispose(): void } | undefined;
  let cleanupScene: ((setup: SceneInstance) => void) | undefined;
  const canvas = document.createElement('canvas');
  try {
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
      setup = await scenes
        .getScene(config.scene)
        .create(
          scenes.createBrowserSceneContext(
            new URL('./', location.href).href,
            new URL('suite-assets/', location.href).href,
          ),
        );
    } finally {
      Math.random = previousRandom;
    }
    cleanupScene = scenes.disposeSceneInstance;
    reporter.phaseEnd('load');
    reporter.phaseStart('process');
    canvas.width = config.width;
    canvas.height = config.height;
    host.replaceChildren(canvas);
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
        progressiveProbes: interactive,
      });
    } finally {
      if (navigatorGPU && requestAdapter) navigatorGPU.requestAdapter = requestAdapter;
    }
    const current = live;
    const advance = renderers.createRendererFrameDriver(current.renderer);
    const orbit = config.motion === 'orbit' ? scenes.createOrbitWorkload(setup, 120, 30) : undefined;
    const complete = () => renderers.completeRenderer(current.renderer);
    if (interactive) {
      const { createNavigation } = await import('./performance-navigation');
      navigation = createNavigation(setup, current, canvas, navigationOptions);
    }
    // Read the adapter selected by the renderer; probing another adapter can misidentify software fallbacks.
    // GPU query readbacks schedule promises and polling per frame. Keep the standard
    // frame-rate test limited to CPU frame boundaries and the renderer's own work.
    const rendererBackend = current.renderer as { backend?: { device?: unknown }; getContext?: () => unknown };
    reporter.environment({
      api: rendererBackend.backend?.device ? 'webgpu' : rendererBackend.getContext ? 'webgl2' : 'other',
      canvasSize: { width: config.width, height: config.height },
      gpuAdapter: adapterInfo,
      gpuTimestampsAvailable: false,
    });
    let frameIndex = 0;
    const draw = (deltaSeconds = 1 / 60) => {
      const frame: FrameContext = {
        index: frameIndex++,
        timeSeconds: frameIndex / 60,
        deltaSeconds: 1 / 60,
        phase: 'measure',
      };
      const token = reporter.frameBegin({ animationTime: frame.timeSeconds });
      navigation?.update(deltaSeconds);
      advance(frame);
      if (orbit) {
        orbit(frame.index);
        current.setCamera(setup!.camera);
      }
      current.render(frame);
      reporter.frameEnd(token);
    };
    await reporter.convergence(canvas);
    reporter.phaseEnd('process');
    reporter.phaseStart('compile');
    // Compile the entire post-processing graph, including lazily built passes, during init.
    draw();
    await complete();
    // The pathtracer defers its first sample until parallel shader compilation finishes.
    // Give browser tasks a turn and keep that work in setup before capture or measurement.
    const compileDeadline = performance.now() + 60000;
    while (config.renderer === 'three-gpu-pathtracer' && current.frames < 1) {
      if (performance.now() > compileDeadline) throw new Error('Pathtracer did not complete its first sample');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      draw();
      await complete();
    }
    reporter.phaseEnd('compile');
    reporter.ready();
    let disposed = false;
    return {
      canvas,
      accumulated: () => current.frames,
      resize(width: number, height: number) {
        current.setSize(width, height);
        setup!.camera.aspect = width / height;
        setup!.camera.updateProjectionMatrix();
        current.setCamera(setup!.camera);
      },
      draw,
      complete,
      dispose() {
        if (disposed) return;
        disposed = true;
        navigation?.dispose();
        current.dispose();
        cleanupScene?.(setup!);
        canvas.remove();
      },
    };
  } catch (error) {
    navigation?.dispose();
    live?.dispose();
    if (setup) cleanupScene?.(setup);
    canvas.remove();
    throw error;
  }
}
