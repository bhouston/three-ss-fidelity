#!/usr/bin/env node
// TRAA-specific metrics not covered by cli compare/ssr-motion-metrics: per-pixel temporal flicker std-dev across a
// run of consecutive static-camera frames, and a mean-gradient-magnitude sharpness ratio (test vs reference).
// Usage:
//   node scripts/traa-metrics.mjs flicker <frame1.avif> <frame2.avif> ...   (>= 2 frames, same scene/camera)
//   node scripts/traa-metrics.mjs sharpness <test.avif> <reference.avif>
import { readRgb } from '../packages/cli/dist/compare.js';

const [mode, ...files] = process.argv.slice(2);

async function flicker(paths) {
  if (paths.length < 2) throw new Error('flicker needs at least 2 frames');
  const images = await Promise.all(paths.map(readRgb));
  const { width, height } = images[0];
  for (const img of images) {
    if (img.width !== width || img.height !== height) throw new Error('frame size mismatch');
  }
  const n = width * height * 3;
  const stds = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    let sum = 0;
    for (const img of images) sum += img.data[p];
    const avg = sum / images.length;
    let sq = 0;
    for (const img of images) sq += (img.data[p] - avg) ** 2;
    stds[p] = Math.sqrt(sq / images.length);
  }
  let sum = 0;
  let maxStd = 0;
  for (const v of stds) {
    sum += v;
    if (v > maxStd) maxStd = v;
  }
  const meanStd = sum / stds.length;
  // 95th percentile: the flicker that matters is concentrated on high-frequency edges, not the flat background.
  const sorted = Float64Array.from(stds).toSorted();
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  console.log(`frames: ${paths.length}`);
  console.log(`mean per-channel std dev (0-255 scale): ${meanStd.toFixed(4)}`);
  console.log(`p95 std dev: ${p95.toFixed(4)}`);
  console.log(`max std dev: ${maxStd.toFixed(4)}`);
}

// Mean Sobel gradient magnitude over luma, as a scalar "sharpness" proxy.
function meanGradientMagnitude({ data, width, height }) {
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 3) {
    luma[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  const at = (x, y) => luma[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      sum += Math.sqrt(gx * gx + gy * gy);
    }
  }
  return sum / (width * height);
}

async function sharpness(testPath, referencePath) {
  const [test, reference] = await Promise.all([readRgb(testPath), readRgb(referencePath)]);
  const testGrad = meanGradientMagnitude(test);
  const refGrad = meanGradientMagnitude(reference);
  console.log(`test mean gradient magnitude: ${testGrad.toFixed(4)}`);
  console.log(`reference mean gradient magnitude: ${refGrad.toFixed(4)}`);
  console.log(`sharpness ratio (test/reference): ${(testGrad / refGrad).toFixed(4)}`);
}

if (mode === 'flicker') {
  await flicker(files);
} else if (mode === 'sharpness') {
  const [test, reference] = files;
  if (!test || !reference) throw new Error('sharpness needs <test> <reference>');
  await sharpness(test, reference);
} else {
  console.error('usage: traa-metrics.mjs flicker <frame1> <frame2> ... | sharpness <test> <reference>');
  process.exit(1);
}
