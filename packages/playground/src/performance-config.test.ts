import { describe, expect, it } from 'vitest';
import { performanceConfiguration, performanceRendererNames } from './performance-config';

describe('performance renderer contract', () => {
  it('maps Three-Base to the stock renderer and includes all real-time variants', () => {
    expect(performanceConfiguration({ renderer: 'three-base' }).renderer).toBe('three-current');
    expect(performanceRendererNames).toContain('three-new-light-probe-ddgi');
    expect(performanceRendererNames).toContain('three-gpu-pathtracer');
  });
  it('rejects external renderers, Blender and invalid experiment combinations', () => {
    for (const renderer of ['blender', 'webgpu-three-pathtracer'])
      expect(() => performanceConfiguration({ renderer })).toThrow('Unsupported performance renderer');
    expect(() => performanceConfiguration({ renderer: 'three-current', experiment: 'hierarchy-combined' })).toThrow();
    expect(() => performanceConfiguration({ renderer: 'three-new', experiment: 'ssgi-4x16' })).not.toThrow();
    for (const experiment of ['ssgi-2x16', 'ssgi-2x8'])
      expect(() => performanceConfiguration({ renderer: 'three-new', experiment })).toThrow();
  });
  it('validates dimensions, deterministic seed and workload', () => {
    for (const params of [{ width: 0 }, { height: 1.5 }, { seed: NaN }, { motion: 'random' }])
      expect(() => performanceConfiguration(params)).toThrow();
  });
});
