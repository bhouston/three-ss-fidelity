import type { SceneSetup } from '@ss-fidelity/scenes';
import { createPathTracerRenderer } from './pathtracer.js';
import { createSSGIRenderer } from './ssgi.js';
import type { LiveRenderer, RendererName, RendererOptions, SSGIWeighting, SSRFastOptions, SSRMethod } from './types.js';

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
  { ssgiWeighting: SSGIWeighting; ssrMethod: SSRMethod; ssrFast?: SSRFastOptions }
> = {
  'three-new-ssgi': { ssgiWeighting: 'solid-angle', ssrMethod: 'fork' },
  'three-ss-legacy': { ssgiWeighting: 'legacy', ssrMethod: 'fork' },
  'three-new-ssr': { ssgiWeighting: 'solid-angle', ssrMethod: 'new' },
  // Every ssrFast field starts at its three-new-ssr-reproducing default; each optimization round flips one
  // on here after passing its own quality gate (see SSR_IMPROVEMENTS.md).
  'three-new-ssr-fast': { ssgiWeighting: 'solid-angle', ssrMethod: 'new', ssrFast: {} },
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
