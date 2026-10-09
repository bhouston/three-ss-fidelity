import type { PerspectiveCamera, ToneMapping, Texture } from 'three';
import type { FrameContext, PipelineProfiler } from '@three-fidelity/runtime';
import type { SceneInstance, GradientBackground, SceneEnvironment } from '@three-fidelity/scenes';

interface SizedRenderer {
  setSize(width: number, height: number, updateStyle?: boolean): void;
}

/**
 * Drive three's temporal nodes once per submitted frame, including unpaced browser batches.
 * These version-specific internals are isolated here. The pipeline must own its animation loop.
 */
export function createRendererFrameDriver(renderer: unknown): (frame: FrameContext) => void {
  const gpu = renderer as {
    isWebGPURenderer?: boolean;
    _animation?: { stop(): void };
    _nodes?: { nodeFrame: { frameId: number; time: number; deltaTime: number } };
    info?: { autoReset: boolean; frame: number; reset(): void };
  };
  if (!gpu._nodes) {
    if (gpu.isWebGPURenderer) throw new Error('Three.js frame driver needs an initialized renderer with nodeFrame');
    return () => {};
  }
  gpu._animation?.stop();
  const nodeFrame = gpu._nodes.nodeFrame;
  return (frame) => {
    if (gpu.info?.autoReset) gpu.info.reset();
    nodeFrame.frameId++;
    nodeFrame.time = frame.timeSeconds;
    nodeFrame.deltaTime = frame.deltaSeconds;
    if (gpu.info) gpu.info.frame = nodeFrame.frameId;
  };
}

export function setRenderSize(renderer: SizedRenderer, camera: PerspectiveCamera, width: number, height: number): void {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('Dimensions must be positive integers');
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

/** Accepts an already-created renderer from any Three.js version or backend. */
export function configureRenderer<T extends { toneMapping: ToneMapping; toneMappingExposure: number }>(
  renderer: T,
  output: { toneMapping: ToneMapping; toneMappingExposure: number },
): T {
  renderer.toneMapping = output.toneMapping;
  renderer.toneMappingExposure = output.toneMappingExposure;
  return renderer;
}

/** Inject backend/version-specific baking and TSL; restore borrowed scene state on disposal. */
export function prepareScene(
  setup: SceneInstance,
  helpers: {
    createGradient(background: GradientBackground): unknown;
    bakeEnvironment(environment: SceneEnvironment): { texture: Texture; dispose(): void };
  },
): () => void {
  const scene = setup.scene as unknown as { environment: Texture | null; backgroundNode?: unknown };
  const originalEnvironment = scene.environment;
  const originalBackground = scene.backgroundNode;
  let target: { texture: Texture; dispose(): void } | undefined;
  try {
    if (setup.gradientBackground) scene.backgroundNode = helpers.createGradient(setup.gradientBackground);
    if (setup.environment) {
      target = helpers.bakeEnvironment(setup.environment);
      scene.environment = target.texture;
    }
  } catch (error) {
    scene.environment = originalEnvironment;
    scene.backgroundNode = originalBackground;
    target?.dispose();
    throw error;
  }
  return () => {
    scene.environment = originalEnvironment;
    scene.backgroundNode = originalBackground;
    target?.dispose();
    target = undefined;
  };
}

/** Adapt arbitrary post-processing graphs without imposing effect configuration or renderer creation. */
export function createLivePipeline<T extends SizedRenderer & { dispose(): void }>(options: {
  name: string;
  renderer: T;
  camera: PerspectiveCamera;
  render(frame?: FrameContext): void;
  disposeGraph(): void;
  profiler?: PipelineProfiler;
}) {
  let frames = 0;
  let disposed = false;
  return {
    name: options.name,
    renderer: options.renderer,
    profiler: options.profiler,
    get frames() {
      return frames;
    },
    render(frame?: FrameContext) {
      options.render(frame);
      frames++;
    },
    setSize(width: number, height: number) {
      setRenderSize(options.renderer, options.camera, width, height);
    },
    setCamera(camera: PerspectiveCamera) {
      if (camera !== options.camera) options.camera.copy(camera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        options.profiler?.dispose();
        options.disposeGraph();
      } finally {
        options.renderer.dispose();
      }
    },
  };
}
