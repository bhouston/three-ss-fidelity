import { beforeEach, expect, it, vi } from 'vitest';
import type { SceneSetup } from '@ss-fidelity/scenes';
import { createRenderer } from './index.js';
import { createSSGIRenderer } from './ssgi.js';
import { createCurrentRenderer } from './three-current.js';
import { createPathTracerRenderer } from './pathtracer.js';
import { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';
import type { RendererName } from './types.js';

vi.mock('./ssgi.js', () => ({ createSSGIRenderer: vi.fn(), passEffects: vi.fn() }));
vi.mock('./three-current.js', () => ({ createCurrentRenderer: vi.fn() }));
vi.mock('./pathtracer.js', () => ({
  createPathTracerRenderer: vi.fn(),
  PATHTRACER_BOUNCES: 8,
  dequantizeAttributes: vi.fn(),
}));
vi.mock('./pathtracer-webgpu.js', () => ({ createWebGPUPathTracerRenderer: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it('selects screen-space methods without changing shared scene quality or using the path tracer', () => {
  const setup = { effects: { ssgi: { sliceCount: 8, stepCount: 32, radius: 32, thickness: 4 } } } as SceneSetup;
  const before = structuredClone(setup);
  const canvas = {} as HTMLCanvasElement;
  const options = { width: 640, height: 480, pass: 'beauty' as const };
  createRenderer('three-new-ssgi', canvas, setup, options);
  createRenderer('three-current', canvas, setup, options);
  createRenderer('three-new-ssr', canvas, setup, options);
  expect(createSSGIRenderer).toHaveBeenNthCalledWith(1, canvas, setup, {
    ...options,
    ssgiWeighting: 'solid-angle',
    ssrMethod: 'fork',
  });
  // three-current is stock npm three.js r186, not a mode of the fork pipeline
  expect(createCurrentRenderer).toHaveBeenCalledWith(canvas, setup, options);
  expect(createSSGIRenderer).toHaveBeenNthCalledWith(2, canvas, setup, {
    ...options,
    ssgiWeighting: 'solid-angle',
    ssrMethod: 'new',
  });
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
  expect(createWebGPUPathTracerRenderer).not.toHaveBeenCalled();
  expect(setup).toEqual(before);
});

it('selects the WebGPU path tracer for three-gpu-pathtracer-webgpu, not the screen-space table or the WebGL one', () => {
  const setup = {} as SceneSetup;
  const canvas = {} as HTMLCanvasElement;
  const options = { width: 640, height: 480, pass: 'beauty' as const };
  createRenderer('three-gpu-pathtracer-webgpu', canvas, setup, options);
  expect(createWebGPUPathTracerRenderer).toHaveBeenCalledWith(canvas, setup, options);
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
  expect(createSSGIRenderer).not.toHaveBeenCalled();
});

it('rejects unknown renderer names rather than silently choosing a method', () => {
  expect(() =>
    createRenderer('unknown' as RendererName, {} as HTMLCanvasElement, {} as SceneSetup, {
      width: 1,
      height: 1,
      pass: 'beauty',
    }),
  ).toThrow('Unknown renderer');
  expect(createSSGIRenderer).not.toHaveBeenCalled();
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
  expect(createWebGPUPathTracerRenderer).not.toHaveBeenCalled();
});
