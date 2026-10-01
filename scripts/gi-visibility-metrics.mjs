// Compare identical camera views after physically removing off-screen room geometry.
// Run after rendering the diagnostic scenes: node scripts/gi-visibility-metrics.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareImages } from '../packages/cli/dist/compare.js';

const root = fileURLToPath(new URL('../results/', import.meta.url));
const pairs = [
  ['gi-room-low-albedo', 'gi-room-open-low-albedo'],
  ['gi-room-high-albedo', 'gi-room-open-high-albedo'],
  ['ssgi-animated', 'ssgi-animated-visible-walls'],
];
const rows = [];
for (const [reference, test] of pairs) {
  for (const renderer of ['three-new', 'three-gpu-pathtracer']) {
    const { metrics } = await compareImages(
      path.join(root, reference, 'beauty', `${renderer}.avif`),
      path.join(root, test, 'beauty', `${renderer}.avif`),
    );
    rows.push({ reference, test, renderer, ...metrics });
  }
}
console.log(JSON.stringify(rows, null, 2));
