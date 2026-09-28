import type { SceneSetup } from '@ss-fidelity/scenes';
import { createPathTracerRenderer } from './pathtracer.js';
import { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';
import { createCurrentRenderer } from './three-current.js';
import { createThreeNewRenderer } from './three-new.js';
import type { LiveRenderer, RendererName, RendererOptions } from './types.js';

export * from './types.js';
export { createPathTracerRenderer, PATHTRACER_BOUNCES } from './pathtracer.js';
export { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';
export { createThreeNewRenderer, passEffects } from './three-new.js';
export { createCurrentRenderer } from './three-current.js';

export function createRenderer(
  name: RendererName,
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  options: RendererOptions,
): Promise<LiveRenderer> {
  switch (name) {
    case 'three-gpu-pathtracer':
      return createPathTracerRenderer(canvas, setup, options);
    case 'three-gpu-pathtracer-webgpu':
      return createWebGPUPathTracerRenderer(canvas, setup, options);
    // unmodified three.js r186 from npm, not the fork (see three-current.ts)
    case 'three-current':
      return createCurrentRenderer(canvas, setup, options);
    case 'three-new':
      return createThreeNewRenderer(canvas, setup, options);
    default:
      throw new Error(`Unknown renderer "${name}"`);
  }
}
