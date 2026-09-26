import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

export const rendererNames = [
  'three-new-ssgi',
  'three-ss-legacy',
  'three-new-ssr',
  'three-new-ssr-fast',
  'three-new-ssgi-fast',
  'three-new-ssr-rt',
  'three-gpu-pathtracer',
] as const;
export type RendererName = (typeof rendererNames)[number];

/** What is rendered: render settings applied to every scene (not scene settings). */
export const passNames = ['beauty', 'direct', 'ao'] as const;
export type PassName = (typeof passNames)[number];

export type SSGIWeighting = 'solid-angle' | 'legacy';

/** Which SSR node implementation the pipeline uses: the three.js fork's or the vendored copy in src/ssr. */
export type SSRMethod = 'fork' | 'new';

/**
 * `three-new-ssr-fast` speed options for the `three-new-ssr` (`ssrMethod: 'new'`) pipeline. Every field
 * defaults to reproducing `three-new-ssr`'s exact reference behavior; each is a separate, togglable
 * optimization measured and logged in SSR_IMPROVEMENTS.md.
 */
export interface SSRFastOptions {
  /**
   * perf(three-new-ssr-fast): precompute the ray parameter where the march leaves the screen once per
   * ray instead of testing all four screen edges every step. Bit-identical output.
   */
  clipRaysToScreen?: boolean;
  /** Binary-refinement bisection steps after a coarse hit (three-new-ssr always uses 8). */
  binaryRefineSteps?: number;
  /**
   * Skip the second (hit-specular) bounce's march for hits at or above this roughness, reading the
   * prefiltered environment for the sampled direction instead. `undefined` (three-new-ssr) always marches.
   */
  secondBounceRoughnessCutoff?: number;
  /** Minimum accumulated pipeline frames (three-new-ssr uses 256). */
  accumFrames?: number;
  /** March step density, 0..1 (three-new-ssr always uses 1); binary refinement still runs on top of it. */
  quality?: number;
  /** Resolution scale of the back-face depth pre-pass, 0..1 (three-new-ssr always uses 1, full resolution). */
  backDepthResolutionScale?: number;
  /** March step density, 0..1, for the second (hit-specular) bounce only; defaults to `quality`. */
  secondBounceQuality?: number;
  /**
   * three-new-ssr-rt: one pipeline frame per rendered frame (no sub-frame accumulation loop). How the stochastic
   * reflections converge over time: `'reset'` keeps the running mean that restarts on every camera change, `'fork'`
   * uses the three.js fork's temporal reprojection + recurrent denoiser chain (the one three-new-ssgi uses for its SSR).
   * See SSR_TEMPORAL.md.
   */
  realtime?: 'reset' | 'fork';
}

/**
 * `three-new-ssgi-fast` speed options for the SSGI side of the `three-new-ssr-fast` pipeline (same `ssrFast`
 * plus these). Every field defaults to reproducing the vendored SSGINode's exact three-new-ssgi-fast-baseline
 * behavior (identical to the fork's `ssgi()`, see `ssgi-fast/SSGINode.js`); each is a separate, togglable
 * optimization measured and logged in SSGI_FAST.md.
 */
export interface SSGIFastOptions {
  /**
   * perf(three-new-ssgi-fast): evaluate the per-pixel initial ray step once instead of re-emitting it (a sin,
   * a mod and spatialOffsets()) inside every horizon-search step. Bit-identical output.
   */
  loopInvariantInitialStep?: boolean;
  /**
   * perf(three-new-ssgi-fast): reproject the previous frame's radiance once into a texture instead of each of
   * SSGINode's ~32 samples/pixel doing its own dependent velocity + previous-frame fetch pair.
   */
  reprojectRadianceOnce?: boolean;
  /**
   * perf(three-new-ssgi-fast): store that reprojected radiance in an RG11B10 target (half the bytes of the
   * renderer's default HDR format) instead of the default. Requires `reprojectRadianceOnce`.
   */
  radianceRG11B10?: boolean;
  /**
   * perf(three-new-ssgi-fast): pack the reprojected radiance and a coarse (octahedral) light-source normal into
   * one 32-bit fetch (SSGINode.lightNormalNode) instead of a separate normal-texture fetch per sample.
   * Supersedes `radianceRG11B10` (uses its own R32UI packed format instead).
   */
  packLightNormals?: boolean;
}

export interface RendererOptions {
  width: number;
  height: number;
  /** SSGI integration method for direct createSSGIRenderer callers; the registry selects it by name. */
  ssgiWeighting?: SSGIWeighting;
  /** SSR node implementation for direct createSSGIRenderer callers; the registry selects it by name. */
  ssrMethod?: SSRMethod;
  /** three-new-ssr-fast speed options for direct createSSGIRenderer callers; the registry selects it by name. */
  ssrFast?: SSRFastOptions;
  /** three-new-ssgi-fast speed options for direct createSSGIRenderer callers; the registry selects it by name. */
  ssgiFast?: SSGIFastOptions;
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
