import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

export const rendererNames = ['three-new-ssgi', 'three-ss-legacy', 'three-new-ssr', 'three-gpu-pathtracer'] as const;
export type RendererName = (typeof rendererNames)[number];

/** What is rendered: render settings applied to every scene (not scene settings). */
export const passNames = ['beauty', 'direct', 'ao'] as const;
export type PassName = (typeof passNames)[number];

export type SSGIWeighting = 'solid-angle' | 'legacy';

/** Which SSR node implementation the pipeline uses: the three.js fork's or the vendored copy in src/ssr. */
export type SSRMethod = 'fork' | 'new';

export interface RendererOptions {
  width: number;
  height: number;
  /** SSGI integration method for direct createSSGIRenderer callers; the registry selects it by name. */
  ssgiWeighting?: SSGIWeighting;
  /** SSR node implementation for direct createSSGIRenderer callers; the registry selects it by name. */
  ssrMethod?: SSRMethod;
  /** Diagnostic GI reconstruction in three-new-ssgi beauty passes; defaults to the existing denoised pipeline. */
  ssgiReconstruction?: 'raw' | 'temporal' | 'denoised';
  /**
   * beauty: the full image, each renderer with its complete pipeline.
   * direct: first-hit lighting only (three-new-ssgi without SSGI/SSR, the pathtracer with a single scatter).
   * ao: ambient occlusion within `SceneSetup.aoRadius`, written linear (1 = unoccluded, also for the background).
   */
  pass: PassName;
}

/** Incremental renderer over one scene: call render() once per animation frame (browser) or in a loop (node). */
export interface LiveRenderer {
  readonly name: RendererName;
  readonly renderer: WebGPURenderer | WebGLRenderer;
  /** Pipeline frames (three-new-ssgi) or accumulated path-traced samples (three-gpu-pathtracer). */
  readonly frames: number;
  /** Renders one frame / one full-frame sample to the canvas. */
  render(): void;
  /** Resizes the drawing buffer and the camera aspect. */
  setSize(width: number, height: number): void;
  /** Adopts a new camera pose (pass the scene camera after moving it, e.g. from OrbitControls); restarts path tracing. */
  setCamera(camera: PerspectiveCamera): void;
  dispose(): void;
}
