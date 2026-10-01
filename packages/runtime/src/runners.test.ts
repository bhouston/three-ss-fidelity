import { expect, it, vi } from 'vitest';
import { benchmark, capture } from './runners.js';
import { compareEntries, parseReport } from './report.js';
import { reportHtml } from './html.js';
import { seededRandom, statistics } from './stats.js';
import type { BenchmarkRun, FrameContext, PipelineProfiler, RenderSession, ReportEntry } from './types.js';

function fixture() {
  let time = 0;
  const frames: FrameContext[] = [];
  const session: RenderSession = {
    pipeline: {
      render(frame) {
        frames.push(frame!);
        time += 2;
      },
      setSize() {},
      dispose() {},
    },
    beforeFrame() {
      time += 1;
    },
    complete: vi.fn(async () => {
      time += 4;
    }),
    dispose: vi.fn(),
  };
  const host = {
    now: () => time,
    yield: vi.fn(async () => {
      time += 1;
    }),
    nextFrame: vi.fn(async () => {
      time += 16;
      return time;
    }),
  };
  return { session, frames, host };
}

it('measures completed batches including GPU completion and preserves an exact partial final batch', async () => {
  const { session, frames, host } = fixture();
  const run = await benchmark(async () => session, { warmupFrames: 2, measureFrames: 7, batchSize: 3 }, host);
  expect(run.frames).toBe(7);
  expect(run.metrics.find((metric) => metric.descriptor.id === 'cpu.submit')?.statistics.mean).toBe(3);
  const total = run.metrics.find((metric) => metric.descriptor.id === 'throughput.frame')!;
  expect(total.sampleUnit).toBe('batch');
  expect(total.samples.map((sample) => sample.value)).toEqual([13 / 3, 13 / 3, 7]);
  expect(frames.map((frame) => frame.phase)).toEqual(['warmup', 'warmup', ...Array(7).fill('measure')]);
  expect(frames.at(-1)?.timeSeconds).toBe(8 / 60);
  expect(session.dispose).toHaveBeenCalledOnce();
});

it('duration mode finishes a complete scripted cycle instead of sampling an arbitrary ending pose', async () => {
  const { session, host } = fixture();
  const run = await benchmark(
    async () => session,
    { durationMs: 1, warmupFrames: 0, batchSize: 2, cycleFrames: 6 },
    host,
  );
  expect(run.frames).toBe(6);
  expect(run.elapsedMs).toBeGreaterThanOrEqual(1);
});

it('cadence measures callback intervals and does not synchronize the GPU per measured frame', async () => {
  const { session, host } = fixture();
  const run = await benchmark(async () => session, { protocol: 'cadence', warmupFrames: 0, measureFrames: 3 }, host);
  expect(
    run.metrics.find((metric) => metric.descriptor.id === 'cadence.frame')?.samples.map((sample) => sample.value),
  ).toEqual([16, 19, 19]);
  expect(session.complete).toHaveBeenCalledTimes(1);
  expect(run.metrics.some((metric) => metric.descriptor.id === 'throughput.frame')).toBe(false);
});

it('profiling records optional internal metrics and retains explicit unavailable status', async () => {
  const { session, host } = fixture();
  let frame = 0;
  const profiler: PipelineProfiler = {
    status: 'supported',
    metrics: [{ id: 'custom.trace', label: 'Trace', unit: 'ms', description: 'A GPU pass' }],
    beginFrame(index) {
      frame = index;
    },
    endFrame() {},
    async resolve() {
      return [{ frame, metric: 'custom.trace', value: 1.5 }];
    },
    invalidSamples: 0,
    dispose() {},
  };
  session.pipeline = { ...session.pipeline, profiler };
  const run = await benchmark(async () => session, { protocol: 'profile', warmupFrames: 0, measureFrames: 2 }, host);
  expect(run.metrics.find((metric) => metric.descriptor.id === 'custom.trace')?.statistics.mean).toBe(1.5);
  expect(run.metrics.find((metric) => metric.descriptor.id === 'profile.frame')?.statistics.mean).toBe(7);
  expect(run.profiling.status).toBe('supported');
  const fallback = fixture();
  const unsupported = await benchmark(
    async () => fallback.session,
    { protocol: 'profile', warmupFrames: 0, measureFrames: 1 },
    fallback.host,
  );
  expect(unsupported.profiling).toMatchObject({ status: 'unsupported', reason: 'Pipeline has no profiler' });
});

it('releases owned resources when rendering throws or cancellation arrives', async () => {
  const { session, host } = fixture();
  session.pipeline.render = () => {
    throw new Error('device lost');
  };
  await expect(benchmark(async () => session, { warmupFrames: 0, measureFrames: 1 }, host)).rejects.toThrow(
    'device lost',
  );
  expect(session.dispose).toHaveBeenCalledOnce();
  const next = fixture();
  const controller = new AbortController();
  next.session.beforeFrame = () => controller.abort(new Error('cancelled'));
  await expect(
    benchmark(async () => next.session, { warmupFrames: 0, measureFrames: 3 }, next.host, controller.signal),
  ).rejects.toThrow('cancelled');
  expect(next.session.dispose).toHaveBeenCalledOnce();
});

it('rejects invalid protocols and incomplete exact motion budgets before allocating a GPU', async () => {
  const factory = vi.fn();
  const { host } = fixture();
  await expect(benchmark(factory, { measureFrames: 0 }, host)).rejects.toThrow('positive integer');
  await expect(benchmark(factory, { measureFrames: 7, cycleFrames: 6 }, host)).rejects.toThrow(
    'complete workload cycles',
  );
  expect(factory).not.toHaveBeenCalled();
});

it('captures multiple logical frames, completes GPU work, and leaves session ownership with the caller', async () => {
  const { session, frames, host } = fixture();
  const read = vi.fn(async () => 'pixels');
  await expect(capture(session, { frames: 3 }, read, host)).resolves.toBe('pixels');
  expect(frames.map((frame) => frame.phase)).toEqual(['capture', 'capture', 'capture']);
  expect(host.yield).toHaveBeenCalledTimes(2);
  expect(session.complete).toHaveBeenCalledOnce();
  expect(session.dispose).not.toHaveBeenCalled();
});

it('computes even medians, sample standard deviation and nearest-rank p95 without mutating inputs', () => {
  const values = [4, 1, 3, 2];
  expect(statistics(values)).toMatchObject({ mean: 2.5, median: 2.5, p95: 4, n: 4 });
  expect(statistics(values).stddev).toBeCloseTo(Math.sqrt(5 / 3));
  expect(values).toEqual([4, 1, 3, 2]);
  expect(() => statistics([])).toThrow();
  expect(() => statistics([Infinity])).toThrow();
  expect(statistics([1]).stddev).toBe(0);
  expect(Array.from({ length: 10 }, seededRandom(1))).toEqual(Array.from({ length: 10 }, seededRandom(1)));
});

it('compares matched repetitions, rejects different timing protocols and safely exports imported evidence', async () => {
  const a = fixture(),
    b = fixture();
  const runA = await benchmark(async () => a.session, { warmupFrames: 0, measureFrames: 2 }, a.host);
  const runB: BenchmarkRun = structuredClone(runA);
  runB.metrics = runB.metrics.map((metric) => ({
    ...metric,
    statistics: { ...metric.statistics, mean: metric.statistics.mean / 2 },
  }));
  const entry: ReportEntry = {
    scene: 'scene',
    renderer: 'baseline',
    experiment: 'baseline',
    workload: {
      width: 10,
      height: 10,
      seed: 1,
      motion: 'static',
      orbitDegrees: 30,
      settings: {},
      history: 'fresh-session-then-warmup',
    },
    runs: [runA],
  };
  const candidate = { ...entry, renderer: 'candidate', runs: [runB] };
  expect(compareEntries(entry, candidate).speedup.mean).toBe(2);
  candidate.runs = [
    await benchmark(async () => b.session, { protocol: 'profile', warmupFrames: 0, measureFrames: 2 }, b.host),
  ];
  expect(() => compareEntries(entry, candidate)).toThrow('different protocols');
  const report = {
    schemaVersion: 1 as const,
    id: '</script><script>alert(1)</script>',
    generatedAt: new Date().toISOString(),
    environment: {},
    provenance: {},
    entries: [entry],
  };
  expect(parseReport(report)).toBe(report);
  expect(reportHtml(report)).not.toContain(report.id);
  expect(() => parseReport({ schemaVersion: 2 })).toThrow('Unsupported');
});
