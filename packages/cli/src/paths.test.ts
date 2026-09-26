import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { comparisonPaths, renderPath } from './paths.js';

describe('comparison output paths', () => {
  const root = path.join(process.cwd(), 'temporary-results');

  it('uses the same delta-R/metrics-R naming for every screen-space renderer', () => {
    const ssgi = comparisonPaths('cornell', 'combined', 'three-new-ssgi', root);
    const legacy = comparisonPaths('cornell', 'combined', 'three-ss-legacy', root);
    expect(ssgi.delta).toBe(path.join(root, 'cornell', 'combined', 'delta-three-new-ssgi.avif'));
    expect(ssgi.metrics).toBe(path.join(root, 'cornell', 'combined', 'metrics-three-new-ssgi.json'));
    expect(legacy.delta).toBe(path.join(root, 'cornell', 'combined', 'delta-three-ss-legacy.avif'));
    expect(legacy.metrics).toBe(path.join(root, 'cornell', 'combined', 'metrics-three-ss-legacy.json'));
    expect(renderPath('cornell', 'combined', 'three-ss-legacy', root)).toBe(
      path.join(root, 'cornell', 'combined', 'three-ss-legacy.avif'),
    );
  });
});
