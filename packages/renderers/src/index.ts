import type { SceneSetup } from '@ss-fidelity/scenes';
import { createPathTracerRenderer } from './pathtracer.js';
import { createSSGIRenderer } from './ssgi.js';
import type {
  LiveRenderer,
  RendererName,
  RendererOptions,
  SSGIFastOptions,
  SSGIWeighting,
  SSRFastOptions,
  SSRMethod,
} from './types.js';

export * from './types.js';
export { createPathTracerRenderer, PATHTRACER_BOUNCES } from './pathtracer.js';
export { createSSGIRenderer, passEffects } from './ssgi.js';

/**
 * Screen-space renderer name -> the ssgi.ts pipeline options that produce it. Keeping this as a table (rather than
 * branching in createRenderer) is what lets later renderers built on top of an existing one (e.g. a future
 * `three-new-ssgi-fast` built on `three-new-ssgi`) be added as one more row. `three-new-ssr-fast` is built on
 * `three-new-ssr` (same ssrMethod) plus `ssrFast`, whose optimizations are each an explicit, togglable flag -
 * see SSR_IMPROVEMENTS.md's "Optimization rounds (three-new-ssr-fast)" section for what each one does and costs.
 */
const screenSpaceOptions: Record<
  Exclude<RendererName, 'three-gpu-pathtracer'>,
  { ssgiWeighting: SSGIWeighting; ssrMethod: SSRMethod; ssrFast?: SSRFastOptions; ssgiFast?: SSGIFastOptions }
> = {
  'three-new-ssgi': { ssgiWeighting: 'solid-angle', ssrMethod: 'fork' },
  'three-ss-legacy': { ssgiWeighting: 'legacy', ssrMethod: 'fork' },
  'three-new-ssr': { ssgiWeighting: 'solid-angle', ssrMethod: 'new' },
  // Every ssrFast field starts at its three-new-ssr-reproducing default; each optimization round flips one
  // on here after passing its own quality gate (see SSR_IMPROVEMENTS.md).
  'three-new-ssr-fast': {
    ssgiWeighting: 'solid-angle',
    ssrMethod: 'new',
    ssrFast: {
      // Round 1: precompute the screen-exit ray parameter once per ray instead of a 4-comparison bounds
      // test every march step. Bit-identical output.
      clipRaysToScreen: true,
      // Round 2 (tried, reverted): fewer binary-refinement steps (4, then 2) barely cleared the ~3%
      // bench noise floor (mean speedup ~1.01x) and 2 steps pushed ssr-diag-metal-hit's RMSE regression
      // to +5.7% (over the ~3% worst-scene budget). The dense 1px march dominates cost far more than its
      // 8-step bisection, so this candidate isn't worth the risk; left at three-new-ssr's default (8).
      // Round 2: skip the second (hit-specular) bounce's march for hits at or above this roughness,
      // reading the prefiltered environment for the sampled direction instead. A rough hit's second
      // bounce is already a poor one-sample stand-in for a wide GGX lobe, so the march there buys little.
      secondBounceRoughnessCutoff: 0.8,
      // Round 3: fewer accumulated pipeline frames per rendered result (time-to-image, not per-frame cost).
      accumFrames: 192,
      // Round 4: coarser march step density (binary refinement, still 8 steps, still recovers the exact
      // contact from within the coarser bracket).
      quality: 0.6,
      // Round 5 (tried, reverted): halving the back-face depth pre-pass's resolution
      // (backDepthResolutionScale, still wired below) pushed mean regression to +1.90% (over budget) and
      // ssr-diag-mirror to +9.5% -- the dual-layer hit test is edge-sensitive (thin/close objects) in a
      // way this pass's full resolution actually matters for, unlike the coarser primary march. Left
      // unset (full resolution, three-new-ssr's behavior).
      // Round 5: lower march density only for the second (hit-specular) bounce, which is already a
      // small correction term for hits below the round-2 roughness cutoff and doesn't feed hit-acceptance
      // like the primary ray or the back-face pass do.
      secondBounceQuality: 0.4,
    },
  },
  // three-new-ssr-rt: three-new-ssr-fast's tracing at one pipeline frame per rendered frame, converging with a
  // temporal filter instead of the sub-frame loop (see SSR_TEMPORAL.md).
  'three-new-ssr-rt': {
    ssgiWeighting: 'solid-angle',
    ssrMethod: 'new',
    ssrFast: {
      clipRaysToScreen: true,
      secondBounceRoughnessCutoff: 0.8,
      quality: 0.6,
      secondBounceQuality: 0.4,
      realtime: 'reset',
    },
  },
  // three-new-ssgi-fast: built on three-new-ssr-fast (same ssgiWeighting/ssrMethod/ssrFast) plus SSGI-side speed
  // flags on the vendored SSGINode (packages/renderers/src/ssgi-fast/), each an explicit, togglable optimization
  // measured and logged in SSGI_FAST.md. Every field starts at its three-new-ssr-fast-reproducing default; each
  // optimization round flips one on here after passing its own quality gate.
  'three-new-ssgi-fast': {
    ssgiWeighting: 'solid-angle',
    ssrMethod: 'new',
    ssrFast: {
      clipRaysToScreen: true,
      secondBounceRoughnessCutoff: 0.8,
      accumFrames: 192,
      quality: 0.6,
      secondBounceQuality: 0.4,
    },
    // Every ssgiFast field starts at its three-new-ssr-fast-reproducing default (false); each optimization
    // round flips one on here after passing its own quality gate (see SSGI_FAST.md).
    ssgiFast: {
      // Round 1: evaluate the per-pixel initial ray step once instead of every horizon-search step. Bit-identical.
      loopInvariantInitialStep: true,
      // Round 2: reproject the previous frame's radiance once into a texture instead of once per SSGI sample
      // (~32 samples/pixel).
      reprojectRadianceOnce: true,
      // Round 3: store that reprojection as RG11B10 (SSGINode's own GI-output format), halving its bytes.
      radianceRG11B10: true,
      // Round 4: pack the reprojected radiance and a coarse light-source normal into one 32-bit fetch, instead
      // of a separate normal-texture fetch per SSGI sample. Supersedes radianceRG11B10's own format.
      // Implemented and quality-gated, but left OFF by default: it measurably regresses higharc_dogwood (a
      // light-SSGI, no-regression scene) with no offsetting benefit there, while adding real but secondary
      // speedup on top of rounds 1-3 on SSGI-heavy scenes. See SSGI_FAST.md's "Round 4" section.
      packLightNormals: false,
    },
  },
};

export function createRenderer(
  name: RendererName,
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  options: RendererOptions,
): Promise<LiveRenderer> {
  if (name === 'three-gpu-pathtracer') return createPathTracerRenderer(canvas, setup, options);
  const screenSpace = screenSpaceOptions[name];
  if (!screenSpace) throw new Error(`Unknown renderer "${name}"`);
  return createSSGIRenderer(canvas, setup, { ...options, ...screenSpace });
}
