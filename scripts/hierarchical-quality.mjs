#!/usr/bin/env node
// Additional quality captures: compare 1080p and camera-motion images against the unmodified pipeline.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hierarchyImageName } from '../packages/renderers/dist/types.js';
import { compareRgb, readRgb } from '../packages/cli/dist/compare.js';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.output/hierarchy-extra' },
    frames: { type: 'string', default: '128' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
  },
});
const frames = Number(values.frames),
  width = Number(values.width),
  height = Number(values.height);
if (![frames, width, height].every((n) => Number.isInteger(n) && n > 0))
  throw new Error('frames, width and height must be positive integers');
const sharp = createRequire(path.join(root, 'packages/cli/package.json'))('sharp');
const out = path.resolve(root, values.out);
await mkdir(out, { recursive: true });
const report = {
  metadata: {
    frames,
    highResolution: [width, height],
    motion: { degrees: 20, moveFrames: 16, captures: [0, 4, 16, 64] },
    profiling: false,
  },
  highResolution: {},
  motion: {},
};
const cases = [
  ['ssr-diag-occlusion', 'ssr-hiz-tight'],
  ['ssr-diag-rough-60', 'ssr-radiance-mips'],
  ['gi-hierarchy-discontinuity', 'ssgi-radiance-mips'],
];
async function run(job, log) {
  const chunks = [];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'packages/cli/dist/render-process.js'), JSON.stringify(job)],
      { cwd: root },
    );
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await writeFile(path.join(out, log), Buffer.concat(chunks));
  if (code !== 0) throw new Error(`Failed GPU capture: ${log}`);
}
for (const kind of ['highResolution', 'motion'])
  for (const [scene, experiment] of cases) {
    for (const variant of ['baseline', experiment]) {
      console.log(kind, scene, variant);
      const job = {
        renderer: 'three-new',
        hierarchyExperiment: variant,
        scenes: [scene],
        passes: ['beauty'],
        frames,
        samples: 4096,
        outDir: path.join(out, kind),
      };
      if (kind === 'highResolution') {
        job.width = width;
        job.height = height;
      } else {
        job.motion = report.metadata.motion;
      }
      await run(job, `${kind}-${scene}-${variant}.log`);
    }
    const row = { experiment };
    report[kind][scene] = row;
    for (const frame of kind === 'motion' ? report.metadata.motion.captures : [null]) {
      const suffix = frame === null ? '' : `@m${frame}`;
      const files = ['three-new', hierarchyImageName('three-new', experiment)].map((label) =>
        path.join(out, kind, scene, 'beauty', `${label}${suffix}.avif`),
      );
      const [baseline, candidate] = await Promise.all(files.map(readRgb));
      const comparison = compareRgb(baseline, candidate);
      const { data, width: deltaWidth, height: deltaHeight } = comparison.delta;
      const delta = path.join(out, `${kind}-${scene}${suffix}-delta.png`);
      await sharp(data, { raw: { width: deltaWidth, height: deltaHeight, channels: 3 } })
        .png()
        .toFile(delta);
      const histogram = new Uint32Array(256);
      for (let i = 0; i < baseline.data.length; i += 3) {
        const e = Math.max(...[0, 1, 2].map((c) => Math.abs(baseline.data[i + c] - candidate.data[i + c])));
        histogram[e]++;
      }
      const total = baseline.width * baseline.height;
      let cumulative = 0,
        p99 = 0;
      for (let i = 0; i < 256; i++) {
        cumulative += histogram[i];
        if (cumulative >= total * 0.99) {
          p99 = i;
          break;
        }
      }
      row[frame === null ? 'settled' : `m${frame}`] = {
        width: baseline.width,
        height: baseline.height,
        baseline: path.relative(out, files[0]),
        candidate: path.relative(out, files[1]),
        delta: path.relative(out, delta),
        metrics: comparison.metrics,
        p99MaxChannelError: p99 / 255,
        fractionAbove8: histogram.slice(9).reduce((a, b) => a + b, 0) / total,
      };
    }
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
console.log('Complete', path.join(out, 'report.json'));
