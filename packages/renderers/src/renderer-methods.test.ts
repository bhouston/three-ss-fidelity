import { beforeEach, expect, it, vi } from 'vitest';
import type { SceneSetup } from '@ss-fidelity/scenes';
import { createRenderer } from './index.js';
import { createSSGIRenderer } from './ssgi.js';
import { createPathTracerRenderer } from './pathtracer.js';
import type { RendererName } from './types.js';

vi.mock('./ssgi.js', () => ({ createSSGIRenderer: vi.fn(), passEffects: vi.fn() }));
vi.mock('./pathtracer.js', () => ({ createPathTracerRenderer: vi.fn(), PATHTRACER_BOUNCES: 8 }));
beforeEach(() => vi.clearAllMocks());

it('selects screen-space methods without changing shared scene quality or using the path tracer', () => {
  const setup = { effects: { ssgi: { sliceCount: 8, stepCount: 32, radius: 32, thickness: 4 } } } as SceneSetup;
  const before = structuredClone(setup);
  const canvas = {} as HTMLCanvasElement;
  const options = { width: 640, height: 480, pass: 'beauty' as const };
  createRenderer('three-new-ssgi', canvas, setup, options);
  createRenderer('three-ss-legacy', canvas, setup, options);
  createRenderer('three-new-ssr', canvas, setup, options);
  expect(createSSGIRenderer).toHaveBeenNthCalledWith(1, canvas, setup, {
    ...options,
    ssgiWeighting: 'solid-angle',
    ssrMethod: 'fork',
  });
  expect(createSSGIRenderer).toHaveBeenNthCalledWith(2, canvas, setup, {
    ...options,
    ssgiWeighting: 'legacy',
    ssrMethod: 'fork',
  });
  expect(createSSGIRenderer).toHaveBeenNthCalledWith(3, canvas, setup, {
    ...options,
    ssgiWeighting: 'solid-angle',
    ssrMethod: 'new',
  });
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
  expect(createSSGIRenderer).not.toHaveBeenCalled();
  expect(createPathTracerRenderer).not.toHaveBeenCalled();
});
