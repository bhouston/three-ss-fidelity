import { checkpoints, ConvergenceMonitor } from './convergence.js';
export interface ProgressiveSession {
  draw(): void;
  complete(): Promise<unknown>;
  completed(): number | Promise<number>;
  limit?(samples: number): void;
}
export interface ProgressiveOptions {
  samples: number;
  noiseThreshold?: number;
  minSamples?: number;
  width: number;
  height: number;
  readPixels(): Promise<Uint8Array>;
  yield(): Promise<void>;
  signal?: AbortSignal;
  stallTimeoutMs?: number;
  now?(): number;
}
/** Capture policy shared by browser and native hosts. Never used to time throughput. */
export async function captureProgressive(session: ProgressiveSession, options: ProgressiveOptions) {
  const { samples, width, height, signal } = options;
  const threshold = options.noiseThreshold ?? 0;
  const minSamples = options.minSamples ?? 128;
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100000)
    throw new Error('samples must be an integer from 1 to 100000');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error('noiseThreshold must be between 0 and 1');
  if (!Number.isSafeInteger(minSamples) || minSamples < 1) throw new Error('minSamples must be a positive integer');
  const monitor = threshold > 0 ? new ConvergenceMonitor(width, height, { threshold, minSamples }) : undefined;
  let completed = await session.completed();
  if (!Number.isFinite(completed) || completed < 0) throw new Error('Invalid renderer sample count');
  const now = options.now ?? (() => performance.now());
  const stallTimeoutMs = options.stallTimeoutMs ?? 120000;
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) throw new Error('Invalid capture stall timeout');
  let lastProgress = now();
  let converged = false;
  for (const target of monitor ? checkpoints(samples) : [samples]) {
    signal?.throwIfAborted();
    session.limit?.(target);
    while (completed < target) {
      signal?.throwIfAborted();
      session.draw();
      await session.complete();
      const next = await session.completed();
      if (!Number.isFinite(next) || next < completed) throw new Error('Invalid renderer sample count');
      if (next > completed) lastProgress = now();
      else if (now() - lastProgress >= stallTimeoutMs)
        throw new Error('Renderer did not complete requested samples before the stall timeout');
      completed = next;
      await options.yield();
    }
    if (monitor?.add(completed, await options.readPixels())) {
      converged = true;
      break;
    }
  }
  await session.complete();
  signal?.throwIfAborted();
  return { samples: completed, noise: monitor?.last?.tile, converged };
}
