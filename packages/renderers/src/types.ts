import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

export const rendererNames = [
  'three-new',
  'three-current',
  'three-gpu-pathtracer',
  'three-gpu-pathtracer-webgpu',
] as const;
export type RendererName = (typeof rendererNames)[number];

/** Independent opt-in experiments. The baseline leaves the production pipeline unchanged. */
export const hierarchyExperiments = ['baseline', 'ssr-hiz-tight', 'ssr-radiance-mips', 'ssgi-radiance-mips'] as const;
export type HierarchyExperiment = (typeof hierarchyExperiments)[number];

/** Static experiment captures use fidelity-kit's identifier alphabet. Motion/debug add their own suffixes. */
export function hierarchyImageName(renderer: string, experiment?: HierarchyExperiment): string {
  return experiment && experiment !== 'baseline' ? `${renderer}-${experiment}` : renderer;
}

/** What is rendered: render settings applied to every scene (not scene settings). */
export const passNames = ['beauty', 'direct', 'ao'] as const;
export type PassName = (typeof passNames)[number];

export interface RendererOptions {
  /** three-new only; rebuild the pipeline when changing this option. */
  hierarchyExperiment?: HierarchyExperiment;
  width: number;
  height: number;
  /** Screen-space renderers: record WebGPU timestamp queries (renderer.resolveTimestampsAsync) for GPU timing. */
  trackTimestamp?: boolean;
  /**
   * Diagnostic (three-new): output NewSSRNode's trace pass instead of the image. 'hits' colors the primary ray's
   * outcome (green: hit, yellow: hit inside a solid, red: Hi-Z out of iterations, blue: left the screen, grey: missed),
   * 'hitcolor' shows the scene color the hit read.
   */
  ssrDebug?: 'hits' | 'hitcolor';
  /**
   * beauty: the full image, each renderer with its complete pipeline.
   * direct: first-hit lighting only (screen-space renderers without SSGI/SSR, the pathtracer with a single scatter).
   * ao: ambient occlusion within `SceneSetup.aoRadius`, written linear (1 = unoccluded, also for the background).
   */
  pass: PassName;
}

/** Incremental renderer over one scene: call render() once per animation frame (browser) or in a loop (node). */
export interface LiveRenderer {
  readonly name: RendererName;
  readonly renderer: WebGPURenderer | WebGLRenderer;
  /** Pipeline frames (screen-space renderers) or accumulated path-traced samples (three-gpu-pathtracer). */
  readonly frames: number;
  /** Renders one frame / one full-frame sample to the canvas. */
  render(): void;
  /** Resizes the drawing buffer and the camera aspect. */
  setSize(width: number, height: number): void;
  /** Adopts a new camera pose (pass the scene camera after moving it, e.g. from OrbitControls); restarts path tracing. */
  setCamera(camera: PerspectiveCamera): void;
  dispose(): void;
}
