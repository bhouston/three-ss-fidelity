import { expect, it, vi } from 'vitest';
import { createWebGPUProfiler, completeRenderer } from './profiling.js';
import { createRendererFrameDriver } from './helpers.js';

it('associates GPU query intervals with logical frames, sums repeated passes, and consumes resolved data once', async () => {
  let uid = '';
  let call = 0;
  const timestamps = new Map<string, number>();
  const backend = {
    updateTimeStampUID() {
      uid = `r:${call++}:f1`;
    },
    getTimestampUID() {
      return uid;
    },
    timestampQueryPool: { render: { timestamps }, compute: null },
  };
  const renderer = {
    backend,
    hasFeature: () => true,
    render(_scene: unknown, _camera: unknown) {
      backend.updateTimeStampUID();
      timestamps.set(uid, 2);
    },
    compute() {},
    async resolveTimestampsAsync() {
      return 4;
    },
  };
  const originalRender = renderer.render;
  const profiler = createWebGPUProfiler(renderer);
  profiler.beginFrame(10);
  renderer.render({ name: 'SSR trace' }, {});
  renderer.render({ name: 'SSR trace' }, {});
  profiler.endFrame();
  const samples = await profiler.resolve();
  expect(samples).toContainEqual({ frame: 10, metric: 'gpu.pass.SSR trace', value: 4 });
  expect(samples).toContainEqual({ frame: 10, metric: 'gpu.pass-sum', value: 4 });
  expect(await profiler.resolve()).toEqual([]);
  profiler.dispose();
  expect(renderer.render).toBe(originalRender);
});

it('reports unsupported timestamps and completes WebGPU or WebGL through explicit boundaries', async () => {
  const profiler = createWebGPUProfiler({ hasFeature: () => false } as never);
  expect(profiler.status).toBe('unsupported');
  expect(await profiler.resolve()).toEqual([]);
  const onSubmittedWorkDone = vi.fn(async () => {});
  await completeRenderer({ backend: { device: { queue: { onSubmittedWorkDone } } } });
  expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
  const finish = vi.fn();
  await completeRenderer({ getContext: () => ({ finish }) });
  expect(finish).toHaveBeenCalledOnce();
  await expect(completeRenderer({})).rejects.toThrow('completion adapter');
});

it('advances temporal-node state for every submission even inside the same display tick', () => {
  const stop = vi.fn();
  const renderer = {
    _animation: { stop },
    _nodes: { nodeFrame: { frameId: 3, time: 0, deltaTime: 0 } },
    info: { autoReset: true, frame: 3, reset: vi.fn() },
  };
  const advance = createRendererFrameDriver(renderer);
  advance({ index: 0, timeSeconds: 0, deltaSeconds: 1 / 60, phase: 'measure' });
  advance({ index: 1, timeSeconds: 1 / 60, deltaSeconds: 1 / 60, phase: 'measure' });
  expect(stop).toHaveBeenCalledOnce();
  expect(renderer._nodes.nodeFrame).toEqual({ frameId: 5, time: 1 / 60, deltaTime: 1 / 60 });
  expect(renderer.info.frame).toBe(5);
});
