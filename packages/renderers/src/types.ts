import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

export const rendererNames = ['three-ss', 'three-gpu-pathtracer'] as const;
export type RendererName = (typeof rendererNames)[number];

/** What is rendered: render settings applied to every scene (not scene settings). */
export const passNames = ['beauty', 'direct'] as const;
export type PassName = (typeof passNames)[number];

export interface RendererOptions {
  width: number;
  height: number;
  /**
   * beauty: the full image, each renderer with its complete pipeline.
   * direct: first-hit lighting only (three-ss without SSGI/SSR, the pathtracer with a single scatter).
   */
  pass: PassName;
}

/** Incremental renderer over one scene: call render() once per animation frame (browser) or in a loop (node). */
export interface LiveRenderer {
  readonly name: RendererName;
  readonly renderer: WebGPURenderer | WebGLRenderer;
  /** Pipeline frames (three-ss) or accumulated path-traced samples (three-gpu-pathtracer). */
  readonly frames: number;
  /** Renders one frame / one full-frame sample to the canvas. */
  render(): void;
  /** Resizes the drawing buffer and the camera aspect. */
  setSize(width: number, height: number): void;
  /** Adopts a new camera pose (pass the scene camera after moving it, e.g. from OrbitControls); restarts path tracing. */
  setCamera(camera: PerspectiveCamera): void;
  dispose(): void;
}
