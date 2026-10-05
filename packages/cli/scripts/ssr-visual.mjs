#!/usr/bin/env node
// Writes side-by-side PNGs (reference | three-new | abs-diff x4) into the scratchpad dir for visual
// inspection with the Read tool.
// Usage: node scripts/ssr-visual.mjs <scratchpad-dir> [scene1,scene2,...] [renderer]
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const resultsDir = path.join(repoRoot, 'fidelity-results');

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: ssr-visual.mjs <out-dir> [scenes] [renderer]');
const renderer = process.argv[4] ?? 'three-new';
const scenes = process.argv[3]
  ? process.argv[3].split(',')
  : readdirSync(resultsDir)
      .filter((name) => name.startsWith('diag-') || name === 'steampunk-camera')
      .toSorted();

for (const scene of scenes) {
  const dir = path.join(resultsDir, scene, 'beauty');
  const refPath = path.join(dir, 'three-gpu-pathtracer.avif');
  const testPath = path.join(dir, `${renderer}.avif`);
  const ref = sharp(refPath);
  const test = sharp(testPath);
  const [refBuf, testBuf] = await Promise.all([
    ref.raw().toBuffer({ resolveWithObject: true }),
    test.raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height, channels } = refBuf.info;
  const diff = Buffer.alloc(refBuf.data.length);
  for (let i = 0; i < diff.length; i++) {
    if (channels === 4 && i % 4 === 3) {
      diff[i] = 255; // alpha
      continue;
    }
    diff[i] = Math.min(255, Math.abs(refBuf.data[i] - testBuf.data[i]) * 4);
  }
  const refPng = await sharp(refBuf.data, { raw: { width, height, channels } }).png().toBuffer();
  const testPng = await sharp(testBuf.data, { raw: { width, height, channels } }).png().toBuffer();
  const diffPng = await sharp(diff, { raw: { width, height, channels } }).png().toBuffer();
  const gap = 4;
  const composite = sharp({
    create: { width: width * 3 + gap * 2, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite([
    { input: refPng, left: 0, top: 0 },
    { input: testPng, left: width + gap, top: 0 },
    { input: diffPng, left: (width + gap) * 2, top: 0 },
  ]);
  const outPath = path.join(outDir, `${scene}-${renderer}.png`);
  await composite.png().toFile(outPath);
  console.log(outPath);
}
