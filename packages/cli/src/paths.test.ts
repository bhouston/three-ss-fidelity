import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { comparisonPaths, renderPath } from './paths.js';

describe('comparison output paths', () => {
  const root = path.join(process.cwd(), 'temporary-results');

  it('keeps existing three-ss filenames and gives legacy results separate files', () => {
    const corrected = comparisonPaths('cornell', 'combined', 'three-ss', root);
    const legacy = comparisonPaths('cornell', 'combined', 'three-ss-legacy', root);
    expect(corrected.delta).toBe(path.join(root, 'cornell', 'combined', 'delta.png'));
    expect(corrected.metrics).toBe(path.join(root, 'cornell', 'combined', 'metrics.json'));
    expect(legacy.delta).toBe(path.join(root, 'cornell', 'combined', 'delta-three-ss-legacy.png'));
    expect(legacy.metrics).toBe(path.join(root, 'cornell', 'combined', 'metrics-three-ss-legacy.json'));
    expect(renderPath('cornell', 'combined', 'three-ss-legacy', root)).toBe(
      path.join(root, 'cornell', 'combined', 'three-ss-legacy.png'),
    );
  });
});
