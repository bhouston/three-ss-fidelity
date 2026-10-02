import { expect, it, vi } from 'vitest';
import { LiveStartup, eventDuration, shaderBreakdown } from './startup';
import type { StartupShaderReport } from '@ss-fidelity/renderers';

const emptyReport = (): StartupShaderReport => ({
  schemaVersion: 1,
  notes: [],
  pendingObservers: 0,
  events: [],
  builders: [],
  sources: [],
});
function fixture() {
  let time = 100;
  const report = emptyReport();
  const profiler = { setPhase: vi.fn(), report: () => report, restore: vi.fn(), settled: vi.fn(async () => {}) };
  const update = vi.fn();
  const capture = new LiveStartup('scene', 'three-new', profiler, update, () => time, 0, 100, 0);
  return {
    capture,
    profiler,
    update,
    report,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

it('accounts page, scene, setup, submission and GPU wait without adding shader child timings twice', async () => {
  const f = fixture();
  await f.capture.measure('scene', () => f.advance(200));
  await f.capture.measure('renderer', async () => {
    f.advance(30);
  });
  f.advance(10); // controls and scheduling
  await f.capture.measure('first-render', () => {
    f.advance(20);
    f.capture.rendered();
  });
  await f.capture.measure('gpu-wait', () => f.advance(500));
  f.report.events.push({
    id: 'build',
    kind: 'builder-total',
    label: 'SSR',
    phase: 'first-render',
    startMs: 330,
    endMs: 345,
    durationMs: 15,
  });
  f.capture.ready();
  const result = f.capture.snapshot();
  expect(result.totalMs).toBe(860);
  expect(result.pageMs).toBe(100);
  expect(result.phases).toMatchObject({ scene: 200, renderer: 30, 'first-render': 20, 'gpu-wait': 500 });
  expect(result.otherMs).toBe(10);
  expect(result.shaderGenerationMs).toBe(15);
  f.advance(1000);
  expect(f.capture.snapshot().totalMs).toBe(860); // later history work doesn't inflate first-frame time
});

it('restores hooks before the early-frame completion wait and stops collecting subsequent frames', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.capture.rendered();
  f.capture.ready();
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const promise = f.capture.finish(() => completion);
  expect(f.profiler.restore).toHaveBeenCalledOnce();
  expect(f.capture.isCapturing).toBe(false);
  f.advance(25);
  finish();
  await promise;
  expect(f.capture.snapshot()).toMatchObject({ frames: 4, capturing: false, historyWaitMs: 25, state: 'ready' });
  f.capture.stop();
  expect(f.profiler.restore).toHaveBeenCalledOnce();
});

it('records failures and restores hooks so the next load can start independently', async () => {
  const f = fixture();
  await expect(
    f.capture.measure('scene', () => {
      f.advance(40);
      throw new Error('asset failed');
    }),
  ).rejects.toThrow('asset failed');
  f.capture.fail(new Error('asset failed'));
  expect(f.capture.snapshot()).toMatchObject({
    state: 'failed',
    capturing: false,
    totalMs: 140,
    error: 'asset failed',
  });
  expect(f.profiler.restore).toHaveBeenCalledOnce();
  const next = fixture();
  expect(next.capture.snapshot()).toMatchObject({ state: 'loading', pipelines: 0, frames: 0 });
});

it('finalizes without an unhandled rejection when early-frame completion fails', async () => {
  const f = fixture();
  f.capture.ready();
  await f.capture.finish(async () => {
    throw new Error('device lost');
  });
  expect(f.capture.snapshot()).toMatchObject({ error: 'device lost', capturing: false });
  expect(f.profiler.restore).toHaveBeenCalledOnce();
});

it('unions overlapping builder spans and groups pipeline sources with their pass', () => {
  const report = emptyReport();
  const event = { phase: 'first-render', materialName: 'SSR', label: 'build' };
  report.events = [
    { ...event, id: 'a', kind: 'builder-total', builderId: 'builder', startMs: 0, endMs: 10, durationMs: 10 },
    { ...event, id: 'b', kind: 'builder-total', startMs: 5, endMs: 12, durationMs: 7 },
    {
      ...event,
      id: 'p',
      kind: 'gpu-pipeline-api',
      startMs: 13,
      endMs: 14,
      durationMs: 1,
      sourceIds: { fragment: 'fragment', vertex: null, compute: null },
    },
  ];
  report.builders = [{ id: 'builder', builds: [{ sourceIds: { fragment: 'fragment' } }] }];
  report.sources = [
    {
      id: 'fragment',
      labels: ['SSR'],
      stages: ['fragment'],
      metrics: { utf8Bytes: 38000, lines: 1000, functions: 8, loops: 2, branches: 35, textureCalls: 30 },
    },
  ];
  expect(eventDuration(report.events.slice(0, 2))).toBe(12);
  const result = shaderBreakdown(report);
  expect(result.shaderGenerationMs).toBe(12);
  expect(result.passes).toEqual([{ name: 'SSR', generationMs: 17, pipelineMs: 1, pipelines: 1, fragmentBytes: 38000 }]);
});

it('shows phase progress during an asynchronous scene load, including renderers without shader hooks', async () => {
  let time = 0;
  const capture = new LiveStartup(
    'scene',
    'three-gpu-pathtracer',
    undefined,
    () => {},
    () => time,
    0,
    0,
    0,
  );
  let finish!: () => void;
  const promise = capture.measure(
    'scene',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  time = 250;
  expect(capture.snapshot().phases.scene).toBe(250);
  finish();
  await promise;
  capture.ready();
  expect(capture.snapshot().shaderReport).toBeUndefined();
  capture.stop();
  expect(capture.snapshot().capturing).toBe(false);
});
