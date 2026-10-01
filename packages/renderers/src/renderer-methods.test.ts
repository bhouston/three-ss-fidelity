import { beforeEach, expect, it, vi } from 'vitest';
import type { SceneSetup } from '@ss-fidelity/scenes';
import { createRenderer } from './index.js';
import { createThreeNewRenderer } from './three-new.js';
import { createCurrentRenderer } from './three-current.js';
import { createPathTracerRenderer } from './pathtracer.js';
import { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';
import { hierarchyExperiments, hierarchyImageName } from './types.js';
import type { RendererName, HierarchyExperiment } from './types.js';

vi.mock('./three-new.js', () => ({ createThreeNewRenderer: vi.fn(), passEffects: vi.fn() }));
vi.mock('./three-current.js', () => ({ createCurrentRenderer: vi.fn() }));
vi.mock('./pathtracer.js', () => ({
  createPathTracerRenderer: vi.fn(),
  PATHTRACER_BOUNCES: 8,
  dequantizeAttributes: vi.fn(),
}));
vi.mock('./pathtracer-webgpu.js', () => ({ createWebGPUPathTracerRenderer: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it('dispatches each renderer name to its own pipeline without changing the scene setup', () => {
  const setup = { effects: { ssgi: { sliceCount: 8, stepCount: 32, radius: 32, thickness: 4 } } } as SceneSetup;
  const before = structuredClone(setup);
  const canvas = {} as HTMLCanvasElement;
  const options = { width: 640, height: 480, pass: 'beauty' as const };
  createRenderer('three-new', canvas, setup, options);
  createRenderer('three-current', canvas, setup, options);
  expect(createThreeNewRenderer).toHaveBeenCalledWith(canvas, setup, options);
  // three-current is stock npm three.js r186, not a mode of the fork pipeline
  expect(createCurrentRenderer).toHaveBeenCalledWith(canvas, setup, options);
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
  expect(createWebGPUPathTracerRenderer).not.toHaveBeenCalled();
  expect(setup).toEqual(before);
});

it('selects the WebGPU path tracer for three-gpu-pathtracer-webgpu, not three-new or the WebGL one', () => {
  const setup = {} as SceneSetup;
  const canvas = {} as HTMLCanvasElement;
  const options = { width: 640, height: 480, pass: 'beauty' as const };
  createRenderer('three-gpu-pathtracer-webgpu', canvas, setup, options);
  expect(createWebGPUPathTracerRenderer).toHaveBeenCalledWith(canvas, setup, options);
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
  expect(createThreeNewRenderer).not.toHaveBeenCalled();
});

it('rejects unknown renderer names rather than silently choosing a method', () => {
  expect(() =>
    createRenderer('unknown' as RendererName, {} as HTMLCanvasElement, {} as SceneSetup, {
      width: 1,
      height: 1,
      pass: 'beauty',
    }),
  ).toThrow('Unknown renderer');
  expect(createThreeNewRenderer).not.toHaveBeenCalled();
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
  expect(createWebGPUPathTracerRenderer).not.toHaveBeenCalled();
});

it('rejects experiments on other renderers before initializing a GPU', () => {
  const options = { width: 640, height: 480, pass: 'beauty' as const, hierarchyExperiment: 'ssr-hiz-tight' as const };
  expect(() => createRenderer('three-current', {} as HTMLCanvasElement, {} as SceneSetup, options)).toThrow(
    'require the three-new',
  );
  expect(createCurrentRenderer).not.toHaveBeenCalled();
  createRenderer('three-new', {} as HTMLCanvasElement, {} as SceneSetup, options);
  expect(createThreeNewRenderer).toHaveBeenCalledWith({}, {}, options);
});

it('rejects misspelled experiment names instead of quietly benchmarking the baseline', () => {
  expect(() =>
    createRenderer('three-new', {} as HTMLCanvasElement, {} as SceneSetup, {
      width: 640,
      height: 480,
      pass: 'beauty',
      hierarchyExperiment: 'ssr-hzi-tight' as HierarchyExperiment,
    }),
  ).toThrow('Unknown hierarchical experiment');
  expect(createThreeNewRenderer).not.toHaveBeenCalled();
});

it('uses suite-compatible experiment image identifiers while preserving baseline names', () => {
  expect(hierarchyImageName('three-new')).toBe('three-new');
  expect(hierarchyImageName('three-new', 'baseline')).toBe('three-new');
  for (const experiment of hierarchyExperiments.filter((name) => name !== 'baseline')) {
    const label = hierarchyImageName('three-new', experiment);
    expect(label).toBe(`three-new-${experiment}`);
    expect(label).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  }
});
