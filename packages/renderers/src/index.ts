import type { SceneInstance } from '@ss-fidelity/scenes';
import { createRenderer as createPathTracerRenderer } from 'fidelity-kit-three-gpu-pathtracer';
import { createCurrentRenderer } from './three-current.js';
import { createVXGIRenderer } from './vxgi.js';
import { createThreeNewRenderer } from './three-new.js';
import { hierarchyExperiments, ssrTemporalProfiles } from './types.js';
import { createRendererProfiler } from './profiling.js';
import type { LiveRenderer, RendererName, RendererOptions } from './types.js';

export * from './types.js';
export * from './helpers.js';
export * from './profiling.js';
export * from './startup.js';
export { createThreeNewRenderer } from './three-new.js';
export { createCurrentRenderer } from './three-current.js';

export function createRenderer(
  name: RendererName,
  canvas: HTMLCanvasElement,
  setup: SceneInstance,
  options: RendererOptions,
): Promise<LiveRenderer> {
  if (options.hierarchyExperiment !== undefined && !hierarchyExperiments.includes(options.hierarchyExperiment)) {
    throw new Error(`Unknown hierarchical experiment "${options.hierarchyExperiment}"`);
  }
  if (options.hierarchyExperiment && options.hierarchyExperiment !== 'baseline' && name !== 'three-new') {
    throw new Error('Hierarchical experiments require the three-new renderer');
  }
  if (options.ssrTemporalProfile !== undefined && !ssrTemporalProfiles.includes(options.ssrTemporalProfile)) {
    throw new Error(`Unknown SSR temporal profile "${options.ssrTemporalProfile}"`);
  }
  if (options.ssrTemporalProfile && name !== 'three-new') {
    throw new Error('SSR temporal profiles require the three-new renderer');
  }
  const instrument = (result: Promise<LiveRenderer>): Promise<LiveRenderer> => {
    if (!options.trackTimestamp) return result;
    return result.then((live) => {
      const profiler = createRendererProfiler(live.renderer);
      const dispose = live.dispose.bind(live);
      return {
        name: live.name,
        renderer: live.renderer,
        get frames() {
          return live.frames;
        },
        get lightBake() {
          return live.lightBake;
        },
        get virtualLights() {
          return live.virtualLights;
        },
        profiler,
        render: live.render.bind(live),
        setSize: live.setSize.bind(live),
        setCamera: live.setCamera.bind(live),
        dispose() {
          try {
            profiler.dispose();
          } finally {
            dispose();
          }
        },
      };
    });
  };
  switch (name) {
    case 'vxgi':
      return instrument(createVXGIRenderer(canvas, setup, options));
    case 'three-gpu-pathtracer':
      return instrument(
        createPathTracerRenderer({
          canvas,
          scene: setup.scene,
          camera: setup.camera,
          ...options,
          toneMapping: setup.effects.toneMapping,
          toneMappingExposure: setup.effects.toneMappingExposure,
          outputColorSpace: 'srgb',
          environment: setup.environment ? { scene: setup.environment.scene } : undefined,
          gradientBackground: setup.gradientBackground,
        }),
      );
    // unmodified three.js r186 from npm, not the fork (see three-current.ts)
    case 'three-current':
      return instrument(createCurrentRenderer(canvas, setup, options));
    case 'three-new-vpl':
      return instrument(createThreeNewRenderer(canvas, setup, options, 'vpl'));
    case 'three-new-vpl-shadow-maps':
      return instrument(createThreeNewRenderer(canvas, setup, options, 'vpl-shadow-maps'));
    case 'three-new-light-bake':
      return instrument(createThreeNewRenderer(canvas, setup, options, 'light-bake'));
    case 'three-new-light-probe-ddgi':
      return instrument(createThreeNewRenderer(canvas, setup, options, 'light-probe-ddgi'));
    case 'three-new-light-probe':
      return instrument(createThreeNewRenderer(canvas, setup, options, 'light-probe'));
    case 'three-new':
      return instrument(createThreeNewRenderer(canvas, setup, options));
    default:
      throw new Error(`Unknown renderer "${name}"`);
  }
}
