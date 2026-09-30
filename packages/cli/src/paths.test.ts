import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metricsPath, renderPath } from './paths.js';

describe('result paths', () => {
  const root = path.join(process.cwd(), 'temporary-results');

  it("uses fidelity-kit's <renderer>.vs-<reference>.metrics.json naming", () => {
    expect(metricsPath('cornell', 'combined', 'three-new', 'three-gpu-pathtracer', root)).toBe(
      path.join(root, 'cornell', 'combined', 'three-new.vs-three-gpu-pathtracer.metrics.json'),
    );
    expect(metricsPath('cornell', 'combined', 'three-current', 'blender', root)).toBe(
      path.join(root, 'cornell', 'combined', 'three-current.vs-blender.metrics.json'),
    );
    expect(renderPath('cornell', 'combined', 'three-current', root)).toBe(
      path.join(root, 'cornell', 'combined', 'three-current.avif'),
    );
  });
});
