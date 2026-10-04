import { hierarchyExperiments, rendererNames } from '@ss-fidelity/renderers';
import type { HierarchyExperiment, RendererName } from '@ss-fidelity/renderers';

export const performanceRendererNames = rendererNames.filter((name) => name !== 'three-gpu-pathtracer');

/** Three-Base is the fixed, stock r186 baseline named three-current by the renderer factory. */
export function performanceConfiguration(params: Record<string, unknown>) {
  const renderer = (
    params.renderer === 'three-base' ? 'three-current' : (params.renderer ?? 'three-current')
  ) as RendererName;
  if (!performanceRendererNames.includes(renderer as (typeof performanceRendererNames)[number]))
    throw new Error(`Unsupported performance renderer: ${renderer}`);
  const experiment = (params.experiment ?? 'baseline') as HierarchyExperiment;
  if (!hierarchyExperiments.includes(experiment) || (experiment !== 'baseline' && renderer !== 'three-new'))
    throw new Error(`Unsupported performance experiment: ${experiment} for ${renderer}`);
  const size = (key: 'width' | 'height', fallback: number) => {
    const value = params[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 16384)
      throw new Error(`${key} must be an integer between 1 and 16384`);
    return value;
  };
  const seed = params.seed ?? 1;
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw new Error('seed must be an integer');
  const scene = params.scene ?? 'ssgi-basic';
  if (typeof scene !== 'string') throw new Error('scene must be a string');
  const motion = params.motion ?? 'static';
  if (motion !== 'static' && motion !== 'orbit') throw new Error('motion must be static or orbit');
  return { renderer, experiment, scene, seed, width: size('width', 1920), height: size('height', 1080), motion };
}
