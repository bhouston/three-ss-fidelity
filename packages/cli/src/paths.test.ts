import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metricsPath, renderPath } from './paths.js';

describe('result paths', () => {
  const root = path.join(process.cwd(), 'temporary-results');

  it("uses fidelity-kit's <renderer>.vs-<reference>.metrics.json naming", () => {
    expect(metricsPath('cornell', 'three-new', 'three-gpu-pathtracer', root)).toBe(
      path.join(root, 'cornell', 'beauty', 'three-new.vs-three-gpu-pathtracer.metrics.json'),
    );
    expect(metricsPath('cornell', 'three-current', 'blender', root)).toBe(
      path.join(root, 'cornell', 'beauty', 'three-current.vs-blender.metrics.json'),
    );
    expect(renderPath('cornell', 'three-current', root)).toBe(
      path.join(root, 'cornell', 'beauty', 'three-current.avif'),
    );
  });
});
