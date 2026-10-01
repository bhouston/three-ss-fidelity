#!/usr/bin/env node
// Beauty PSNR (dB) vs the committed path-traced reference for `cli render --motion` captures (<renderer>@m<k>.avif).
// Usage: node scripts/ssr-motion-metrics.mjs <captures-dir> <renderer1,renderer2,...> <k1,k2,...> [scene-prefix] [reference]
// [reference] scores against another committed render instead (e.g. another renderer's committed render).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRgb, readRgb } from '../packages/cli/dist/compare.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [dir, rendererList, captureList, prefix = '', referenceName = 'three-gpu-pathtracer'] = process.argv.slice(2);
if (!dir || !rendererList || !captureList) {
  console.error('usage: ssr-motion-metrics.mjs <captures-dir> <renderers> <captures> [scene-prefix]');
  process.exit(1);
}
const renderers = rendererList.split(',');
const captures = captureList.split(',');
const columns = renderers.flatMap((r) => captures.map((k) => `${r}@m${k}`));
const scenes = readdirSync(dir)
  .filter((s) => s.startsWith(prefix))
  .toSorted();

const sums = Object.fromEntries(columns.map((c) => [c, []]));
console.log(['scene', ...columns].join(' | '));
for (const scene of scenes) {
  const reference = path.join(repoRoot, 'results', scene, 'beauty', `${referenceName}.avif`);
  const cells = [scene];
  for (const column of columns) {
    const test = path.join(dir, scene, 'beauty', `${column}.avif`);
    if (!existsSync(test) || !existsSync(reference)) {
      cells.push('n/a');
      continue;
    }
    const { metrics } = compareRgb(...(await Promise.all([reference, test].map(readRgb))));
    sums[column].push(metrics.psnr ?? Infinity);
    cells.push(metrics.psnr?.toFixed(4) ?? '∞');
  }
  console.log(cells.join(' | '));
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(['**mean**', ...columns.map((c) => (sums[c].length ? mean(sums[c]).toFixed(4) : 'n/a'))].join(' | '));
