import { beforeEach, expect, it, vi } from 'vitest';
import type { SceneSetup } from '@ss-fidelity/scenes';
import { createRenderer } from './index.js';
import { createThreeSSRenderer } from './three-ss.js';
import { createPathTracerRenderer } from './pathtracer.js';
import type { RendererName } from './types.js';

vi.mock('./three-ss.js', () => ({ createThreeSSRenderer: vi.fn(), passEffects: vi.fn() }));
vi.mock('./pathtracer.js', () => ({ createPathTracerRenderer: vi.fn(), PATHTRACER_BOUNCES: 8 }));
beforeEach(() => vi.clearAllMocks());

it('selects screen-space methods without changing shared scene quality or using the path tracer', () => {
  const setup = { effects: { ssgi: { sliceCount: 8, stepCount: 32, radius: 32, thickness: 4 } } } as SceneSetup;
  const before = structuredClone(setup);
  const canvas = {} as HTMLCanvasElement;
  const options = { width: 640, height: 480, pass: 'beauty' as const };
  createRenderer('three-ss', canvas, setup, options);
  createRenderer('three-ss-legacy', canvas, setup, options);
  expect(createThreeSSRenderer).toHaveBeenNthCalledWith(1, canvas, setup, { ...options, ssgiWeighting: 'solid-angle' });
  expect(createThreeSSRenderer).toHaveBeenNthCalledWith(2, canvas, setup, { ...options, ssgiWeighting: 'legacy' });
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
  expect(setup).toEqual(before);
});

it('rejects unknown renderer names rather than silently choosing a method', () => {
  expect(() =>
    createRenderer('unknown' as RendererName, {} as HTMLCanvasElement, {} as SceneSetup, {
      width: 1,
      height: 1,
      pass: 'beauty',
    }),
  ).toThrow('Unknown renderer');
  expect(createThreeSSRenderer).not.toHaveBeenCalled();
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
});
