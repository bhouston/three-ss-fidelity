import type { Statistics } from './types.js';

/** Sample standard deviation; nearest-rank p95. All inputs must be finite. */
export function statistics(values: readonly number[]): Statistics {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Statistics require nonempty finite samples');
  }
  const n = values.length;
  const sorted = values.toSorted((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const mid = Math.floor(n / 2);
  return {
    n,
    mean,
    stddev: n > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0,
    median: n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted[n - 1]!,
  };
}

export function seededRandom(initialSeed: number): () => number {
  let seed = initialSeed;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
