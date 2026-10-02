import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { LivePipeline } from '@ss-fidelity/runtime';

export const rendererNames = [
  'three-new',
  'three-new-light-probe',
  'three-current',
  'three-gpu-pathtracer',
  'three-gpu-pathtracer-webgpu',
] as const;
export type RendererName = (typeof rendererNames)[number];

export interface SSGIWorkExperiment {
  earlyExit?: boolean;
  reuseDuplicateTexels?: boolean;
  sliceScale?: number;
  stepScale?: number;
}

/** Work experiments inherit hierarchy-combined; sample budgets scale each scene's preset. */
export const ssgiWorkExperiments = {
  'ssgi-early-exit': { earlyExit: true },
  'ssgi-reuse-texels': { reuseDuplicateTexels: true },
  'ssgi-redundant-work': { earlyExit: true, reuseDuplicateTexels: true },
  'ssgi-4x32': { sliceScale: 0.5 },
  'ssgi-8x16': { stepScale: 0.5 },
  'ssgi-4x16': { sliceScale: 0.5, stepScale: 0.5 },
  'ssgi-2x16': { sliceScale: 0.25, stepScale: 0.5 },
  'ssgi-2x8': { sliceScale: 0.25, stepScale: 0.25 },
  'ssgi-6x32': { sliceScale: 0.75 },
  'ssgi-8x24': { stepScale: 0.75 },
  'ssgi-6x24': { sliceScale: 0.75, stepScale: 0.75 },
  'ssgi-7x32': { sliceScale: 0.875 },
  'ssgi-8x28': { stepScale: 0.875 },
} as const satisfies Record<string, SSGIWorkExperiment>;

/** Opt-in experiments, including a combined profile. The baseline leaves the production pipeline unchanged. */
export const hierarchyExperiments = [
  'baseline',
  'ssr-hiz-tight',
  'ssr-radiance-mips',
  'ssgi-radiance-mips',
  'hierarchy-combined',
  ...(Object.keys(ssgiWorkExperiments) as (keyof typeof ssgiWorkExperiments)[]),
  'ssgi-half',
  'ssgi-third',
  'ssr-temporal-validated',
  'ssr-temporal-gaussian',
] as const;
export type HierarchyExperiment = (typeof hierarchyExperiments)[number];

/** Static experiment captures use fidelity-kit's identifier alphabet. Motion/debug add their own suffixes. */
export function hierarchyImageName(renderer: string, experiment?: HierarchyExperiment): string {
  return experiment && experiment !== 'baseline' ? `${renderer}-${experiment}` : renderer;
}

/** Literature-informed SSR ablations; baseline remains the production default. */
export const ssrTemporalProfiles = ['baseline', 'validated', 'gaussian'] as const;
export type SSRTemporalProfile = (typeof ssrTemporalProfiles)[number];

export interface RendererOptions {
  /** three-new only: opt-in reflection history ablations; rebuild the pipeline when changing. */
  ssrTemporalProfile?: SSRTemporalProfile;
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
}

/** Incremental renderer over one scene: call render() once per animation frame (browser) or in a loop (node). */
export interface LiveRenderer extends LivePipeline {
  readonly name: string;
  readonly renderer: WebGPURenderer | WebGLRenderer;
  /** Pipeline frames (screen-space renderers) or accumulated path-traced samples (three-gpu-pathtracer). */
  readonly frames: number;
  /** Renders one frame / one full-frame sample to the canvas. */
  /** Resizes the drawing buffer and the camera aspect. */
  setSize(width: number, height: number): void;
  /** Adopts a new camera pose (pass the scene camera after moving it, e.g. from OrbitControls); restarts path tracing. */
  setCamera(camera: PerspectiveCamera): void;
  dispose(): void;
}
