import type { SceneSetup } from '@ss-fidelity/scenes';
import { createPathTracerRenderer } from './pathtracer.js';
import { createSSGIRenderer } from './ssgi.js';
import type { LiveRenderer, RendererName, RendererOptions, SSGIWeighting, SSRMethod } from './types.js';

export * from './types.js';
export { createPathTracerRenderer, PATHTRACER_BOUNCES } from './pathtracer.js';
export { createSSGIRenderer, passEffects } from './ssgi.js';

/**
 * Screen-space renderer name -> the ssgi.ts pipeline options that produce it. Keeping this as a table (rather than
 * branching in createRenderer) is what lets later renderers built on top of an existing one (e.g. a future
 * `three-new-ssr-fast` built on `three-new-ssr`, or `three-new-ssgi-fast` built on that) be added as one more row.
 */
const screenSpaceOptions: Record<
  Exclude<RendererName, 'three-gpu-pathtracer'>,
  { ssgiWeighting: SSGIWeighting; ssrMethod: SSRMethod }
> = {
  'three-new-ssgi': { ssgiWeighting: 'solid-angle', ssrMethod: 'fork' },
  'three-ss-legacy': { ssgiWeighting: 'legacy', ssrMethod: 'fork' },
  'three-new-ssr': { ssgiWeighting: 'solid-angle', ssrMethod: 'new' },
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
