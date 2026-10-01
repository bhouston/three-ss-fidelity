import type { SceneSetup } from '@ss-fidelity/scenes';
import { createRenderer as createPathTracerRenderer } from 'fidelity-kit-three-gpu-pathtracer';
import { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';
import { createCurrentRenderer } from './three-current.js';
import { createThreeNewRenderer } from './three-new.js';
import { hierarchyExperiments } from './types.js';
import type { LiveRenderer, RendererName, RendererOptions } from './types.js';

export * from './types.js';
export { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';
export { createThreeNewRenderer } from './three-new.js';
export { createCurrentRenderer } from './three-current.js';

export function createRenderer(
  name: RendererName,
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  options: RendererOptions,
): Promise<LiveRenderer> {
  if (options.hierarchyExperiment !== undefined && !hierarchyExperiments.includes(options.hierarchyExperiment)) {
    throw new Error(`Unknown hierarchical experiment "${options.hierarchyExperiment}"`);
  }
  if (options.hierarchyExperiment && options.hierarchyExperiment !== 'baseline' && name !== 'three-new') {
    throw new Error('Hierarchical experiments require the three-new renderer');
  }
  switch (name) {
    case 'three-gpu-pathtracer':
      return createPathTracerRenderer({
        canvas,
        scene: setup.scene,
        camera: setup.camera,
        ...options,
        toneMapping: setup.effects.toneMapping,
        toneMappingExposure: setup.effects.toneMappingExposure,
        outputColorSpace: 'srgb',
        environment: setup.environment ? { scene: setup.environment.scene } : undefined,
        gradientBackground: setup.gradientBackground,
      });
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
