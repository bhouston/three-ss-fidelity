import type { SceneSetup } from '@ss-fidelity/scenes';
import { createPathTracerRenderer } from './pathtracer.js';
import { createThreeSSRenderer } from './three-ss.js';
import type { LiveRenderer, RendererName, RendererOptions } from './types.js';

export * from './types.js';
export { createPathTracerRenderer, PATHTRACER_BOUNCES } from './pathtracer.js';
export { createThreeSSRenderer, passEffects } from './three-ss.js';

export function createRenderer(
  name: RendererName,
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  options: RendererOptions,
): Promise<LiveRenderer> {
  if (name === 'three-gpu-pathtracer') return createPathTracerRenderer(canvas, setup, options);
  if (name !== 'three-ss' && name !== 'three-ss-legacy') throw new Error(`Unknown renderer "${name}"`);
  return createThreeSSRenderer(canvas, setup, {
    ...options,
    ssgiWeighting: name === 'three-ss-legacy' ? 'legacy' : 'solid-angle',
  });
}
