import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { comparisonPaths, renderPath } from './paths.js';

describe('comparison output paths', () => {
  const root = path.join(process.cwd(), 'temporary-results');

  it('uses the same delta-R/metrics-R naming for every screen-space renderer', () => {
    const ssgi = comparisonPaths('cornell', 'combined', 'three-new', root);
    const current = comparisonPaths('cornell', 'combined', 'three-current', root);
    expect(ssgi.delta).toBe(path.join(root, 'cornell', 'combined', 'delta-three-new.avif'));
    expect(ssgi.metrics).toBe(path.join(root, 'cornell', 'combined', 'metrics-three-new.json'));
    expect(current.delta).toBe(path.join(root, 'cornell', 'combined', 'delta-three-current.avif'));
    expect(current.metrics).toBe(path.join(root, 'cornell', 'combined', 'metrics-three-current.json'));
    expect(renderPath('cornell', 'combined', 'three-current', root)).toBe(
      path.join(root, 'cornell', 'combined', 'three-current.avif'),
    );
  });
});
