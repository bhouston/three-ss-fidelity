import { statistics } from './stats.js';
import type {
  BenchmarkOptions,
  BenchmarkRun,
  FrameContext,
  MetricDescriptor,
  MetricResult,
  RenderSession,
} from './types.js';

export const defaultBenchmarkOptions: BenchmarkOptions = {
  protocol: 'throughput',
  durationMs: 5000,
  warmupFrames: 60,
  batchSize: 20,
  cycleFrames: 1,
  stepSeconds: 1 / 60,
};

export interface RunnerHost {
  now(): number;
  /** Yield to the host without adding a timed artificial per-frame sleep. */
  yield(): Promise<void>;
  /** Required by cadence runs; resolves with the next animation-frame timestamp. */
  nextFrame?(): Promise<number>;
}

export function validateBenchmarkOptions(options: BenchmarkOptions): void {
  for (const key of ['warmupFrames', 'batchSize', 'cycleFrames'] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'warmupFrames' ? 0 : 1)) {
      throw new Error(`${key} must be ${key === 'warmupFrames' ? 'a nonnegative' : 'a positive'} integer`);
    }
  }
  if (!['throughput', 'cadence', 'profile'].includes(options.protocol)) throw new Error('Unknown benchmark protocol');
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) throw new Error('durationMs must be positive');
  if (!Number.isFinite(options.stepSeconds) || options.stepSeconds <= 0)
    throw new Error('stepSeconds must be positive');
  if (
    options.measureFrames !== undefined &&
    (!Number.isSafeInteger(options.measureFrames) || options.measureFrames < 1)
  ) {
    throw new Error('measureFrames must be a positive integer');
  }
  if (options.measureFrames !== undefined && options.measureFrames % options.cycleFrames !== 0) {
    throw new Error('measureFrames must contain complete workload cycles');
  }
}

const descriptors: MetricDescriptor[] = [
  {
    id: 'cpu.submit',
    label: 'CPU update + submit',
    unit: 'ms',
    description: 'Wall time for workload update and render submission; excludes waiting for GPU completion.',
  },
  {
    id: 'throughput.frame',
    label: 'Completed-work ms/frame',
    unit: 'ms',
    description: 'Batch wall time divided by completed frames; p95 describes batches, not individual frames.',
  },
  {
    id: 'cadence.frame',
    label: 'Browser frame interval',
    unit: 'ms',
    description:
      'Time between animation-frame callbacks; includes refresh pacing and scheduling, not verified presentation.',
  },
  {
    id: 'profile.frame',
    label: 'Synchronized profile ms/frame',
    unit: 'ms',
    description: 'Instrumented frame including query resolution and completion; changes CPU/GPU overlap.',
  },
];

function context(index: number, stepSeconds: number, phase: FrameContext['phase']): FrameContext {
  return { index, timeSeconds: index * stepSeconds, deltaSeconds: stepSeconds, phase };
}

/** Always owns and disposes a fresh session; warmup and measurement share continuous logical time. */
export async function benchmark(
  factory: () => Promise<RenderSession>,
  input: Partial<BenchmarkOptions>,
  host: RunnerHost,
  signal?: AbortSignal,
): Promise<BenchmarkRun> {
  const options = { ...defaultBenchmarkOptions, ...input };
  validateBenchmarkOptions(options);
  if (options.protocol === 'cadence' && !host.nextFrame) throw new Error('Cadence needs a nextFrame host hook');
  signal?.throwIfAborted();
  const session = await factory();
  const profiler = options.protocol === 'profile' ? session.pipeline.profiler : undefined;
  const activeProfiler = profiler?.status === 'supported' ? profiler : undefined;
  const samples = new Map<string, { frame: number; value: number }[]>();
  const add = (id: string, frame: number, value: number) => {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid sample for ${id}`);
    const values = samples.get(id) ?? [];
    values.push({ frame, value });
    samples.set(id, values);
  };
  const render = (index: number, phase: FrameContext['phase']) => {
    signal?.throwIfAborted();
    const frame = context(index, options.stepSeconds, phase);
    const start = host.now();
    session.beforeFrame?.(frame);
    session.pipeline.render(frame);
    return host.now() - start;
  };
  try {
    for (let index = 0; index < options.warmupFrames; index++) {
      render(index, 'warmup');
      await session.complete();
      // Drain warmup queries, including automatic query-pool rollover, outside measured samples.
      if (activeProfiler) await activeProfiler.resolve();
      await host.yield();
    }
    await session.complete();
    let previousFrame = options.protocol === 'cadence' ? await host.nextFrame!() : 0;
    const start = host.now();
    let frames = 0;
    let elapsedMs = 0;
    do {
      const remaining = options.measureFrames === undefined ? options.batchSize : options.measureFrames - frames;
      // Duration runs stop only at boundaries shared by batch and workload cycle.
      const count = options.protocol === 'throughput' ? Math.min(options.batchSize, remaining) : 1;
      const batchStart = host.now();
      for (let offset = 0; offset < count; offset++) {
        const index = options.warmupFrames + frames;
        if (options.protocol === 'cadence') {
          const timestamp = await host.nextFrame!();
          add('cadence.frame', index, timestamp - previousFrame);
          previousFrame = timestamp;
        }
        activeProfiler?.beginFrame(index);
        const frameStart = host.now();
        add('cpu.submit', index, render(index, 'measure'));
        activeProfiler?.endFrame();
        if (options.protocol === 'profile') {
          for (const sample of (await activeProfiler?.resolve()) ?? []) add(sample.metric, sample.frame, sample.value);
          await session.complete();
          add('profile.frame', index, host.now() - frameStart);
        }
        frames++;
      }
      if (options.protocol === 'throughput') {
        await session.complete();
        add('throughput.frame', options.warmupFrames + frames - count, (host.now() - batchStart) / count);
      }
      // Cadence itself yields; profile/throughput yield once per batch/frame for async compilation and cancellation.
      if (options.protocol !== 'cadence') await host.yield();
      elapsedMs = host.now() - start;
    } while (
      options.measureFrames !== undefined
        ? frames < options.measureFrames
        : elapsedMs < options.durationMs || frames % options.cycleFrames !== 0
    );
    // Keep the last submitted frame inside throughput's completed-work boundary. Cadence does not claim completion FPS.
    const metrics: MetricResult[] = [...descriptors, ...(activeProfiler?.metrics ?? [])]
      .filter((descriptor) => samples.has(descriptor.id))
      .map((descriptor) => ({
        descriptor,
        sampleUnit: descriptor.id === 'throughput.frame' ? 'batch' : 'frame',
        samples: samples.get(descriptor.id)!,
        statistics: statistics(samples.get(descriptor.id)!.map((sample) => sample.value)),
      }));
    return {
      options,
      elapsedMs,
      frames,
      fps: (frames * 1000) / elapsedMs,
      metrics,
      profiling:
        options.protocol !== 'profile'
          ? { status: 'disabled', invalidSamples: 0 }
          : {
              status: profiler?.status ?? 'unsupported',
              reason: profiler?.reason ?? (!profiler ? 'Pipeline has no profiler' : undefined),
              invalidSamples: profiler?.invalidSamples ?? 0,
            },
    };
  } finally {
    session.dispose();
  }
}

/** A single output may require multiple temporal frames or path-traced samples. */
export async function capture<T>(
  session: RenderSession,
  options: {
    frames: number;
    stepSeconds?: number;
    /** Count accumulated samples instead of render calls (calls may be skipped during shader compilation). */
    accumulated?: { count(): number; stallTimeoutMs?: number };
  },
  read: () => Promise<T>,
  host: Pick<RunnerHost, 'yield'> & Partial<Pick<RunnerHost, 'now'>>,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(options.frames) || options.frames < 1)
    throw new Error('Capture frames must be a positive integer');
  const now = host.now ?? (() => performance.now());
  const stallTimeoutMs = options.accumulated?.stallTimeoutMs ?? 120_000;
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0)
    throw new Error('Capture stall timeout must be positive and finite');
  let count = options.accumulated?.count() ?? 0;
  if (!Number.isFinite(count) || count < 0) throw new Error('Invalid accumulated sample count');
  const target = count + options.frames;
  let lastProgress = now();
  for (let index = 0; count < target; index++) {
    signal?.throwIfAborted();
    const frame = context(index, options.stepSeconds ?? 1 / 60, 'capture');
    session.beforeFrame?.(frame);
    session.pipeline.render(frame);
    const next = options.accumulated?.count() ?? index + 1;
    if (!Number.isFinite(next) || next < count) throw new Error('Invalid accumulated sample count');
    if (next > count) lastProgress = now();
    else if (now() - lastProgress >= stallTimeoutMs)
      throw new Error(
        `Capture stalled: accumulated ${count} of ${target} samples; no progress for ${stallTimeoutMs}ms`,
      );
    count = next;
    if (count < target) await host.yield();
  }
  signal?.throwIfAborted();
  await session.complete();
  signal?.throwIfAborted();
  const result = await read();
  signal?.throwIfAborted();
  return result;
}
