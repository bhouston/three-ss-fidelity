#!/usr/bin/env node
// Run after pnpm build. Each scene/variant gets an isolated GPU process. Timings run sequentially.
// node scripts/hierarchical-experiments.mjs --out .output/hierarchy --repeats 3
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hierarchyExperiments, hierarchyImageName, ssgiWorkExperiments } from '../packages/renderers/dist/types.js';
import { compareRgb, readRgb, psnrDrop } from '../packages/cli/dist/compare.js';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../packages/cli/package.json', import.meta.url))('sharp');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.output/hierarchy' },
    references: { type: 'string', default: 'fidelity-results' },
    experiments: {
      type: 'string',
      default: [
        ...hierarchyExperiments.filter((name) => name !== 'baseline' && !Object.hasOwn(ssgiWorkExperiments, name)),
        'sh-probes',
        'ddgi-probes',
      ].join(','),
    },
    scenes: { type: 'string' },
    repeats: { type: 'string', default: '3' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
    frames: { type: 'string', default: '128' },
    'quality-width': { type: 'string' },
    'quality-height': { type: 'string' },
    warmup: { type: 'string', default: '60' },
    measure: { type: 'string', default: '120' },
    threshold: { type: 'string', default: '0.1' },
    'skip-timing': { type: 'boolean', default: false },
    'skip-quality': { type: 'boolean', default: false },
  },
});
const positive = (name) => {
  const number = Number(values[name]);
  if (!Number.isInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`);
  return number;
};
const repeats = positive('repeats');
const width = positive('width'),
  height = positive('height');
const frames = positive('frames'),
  warmup = positive('warmup'),
  measure = positive('measure');
if ((values['quality-width'] === undefined) !== (values['quality-height'] === undefined)) {
  throw new Error('--quality-width and --quality-height must be specified together; use matching references');
}
const qualityWidth = values['quality-width'] === undefined ? undefined : positive('quality-width');
const qualityHeight = values['quality-height'] === undefined ? undefined : positive('quality-height');
const threshold = Number(values.threshold);
if (!Number.isFinite(threshold) || threshold < 0) throw new Error('--threshold must be finite and nonnegative');
const out = path.resolve(root, values.out);
const definitions = {
  'sh-probes': [
    'ssgi-basic',
    'ssgi-rounded',
    'ssgi-animated',
    'gi-emitter-corner',
    'gi-emitter-corner-thick',
    'gi-room-open-high-albedo',
    'gi-room-high-albedo',
    'gi-room-low-albedo',
    'gltf-coffeemat',
  ],
  'ssr-hiz-tight': [
    'ssr-diag-mirror',
    'ssr-diag-grazing',
    'ssr-diag-occlusion',
    'ssr-diag-metal-hit',
    'ssr-diag-rough-30',
    'ssr-diag-odd-size',
  ],
  'ssr-radiance-mips': ['ssr-diag-mirror', 'ssr-diag-rough-30', 'ssr-diag-rough-60', 'ssr-diag-metal-hit'],
  'ssgi-radiance-mips': [
    'ssgi-basic',
    'ssgi-rounded',
    'gi-emitter-corner-dense',
    'gi-room-open-high-albedo',
    'gi-hierarchy-discontinuity',
  ],
};
definitions['hierarchy-combined'] = [...new Set(Object.values(definitions).flat()), 'ssgi-metallic'];
for (const name of Object.keys(ssgiWorkExperiments)) definitions[name] = definitions['ssgi-radiance-mips'];
definitions['ssgi-half'] = [...definitions['ssgi-radiance-mips'], 'ssgi-metallic'];
definitions['ssgi-third'] = definitions['ssgi-half'];
definitions['ssr-temporal-validated'] = [
  'ssr-diag-mirror',
  'ssr-diag-rough-30',
  'ssr-diag-rough-60',
  'ssr-steampunk-camera',
];
definitions['ssr-temporal-gaussian'] = definitions['ssr-temporal-validated'];
definitions['ddgi-probes'] = [...definitions['sh-probes'], 'gi-probe-thin-wall', 'gi-probe-thick-wall'];
const rendererFor = (variant) =>
  variant === 'sh-probes'
    ? 'three-new-light-probe'
    : variant === 'ddgi-probes'
      ? 'three-new-light-probe-ddgi'
      : 'three-new';
const experimentFor = (variant) => (variant === 'sh-probes' || variant === 'ddgi-probes' ? 'baseline' : variant);
const experiments = values.experiments.split(',');
for (const experiment of experiments) if (!definitions[experiment]) throw new Error(`Unknown experiment ${experiment}`);
const scenes = values.scenes?.split(',') ?? [...new Set(experiments.flatMap((e) => definitions[e]))];
const report = {
  metadata: {
    date: new Date().toISOString(),
    revision: execFileSync('git-dedup', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    // Uncommitted shader experiments must be preserved beside the report for reproducibility.
    dirty: execFileSync('git-dedup', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    node: process.version,
    timing: {
      enabled: !values['skip-timing'],
      width,
      height,
      warmup,
      measure,
      repeats,
      method: 'median GPU-synchronized batch wall time; separate timestamp run',
    },
    quality: {
      enabled: !values['skip-quality'],
      frames,
      dimensions: qualityWidth ? `${qualityWidth}x${qualityHeight}` : 'native scene dimensions',
      encoding: 'AVIF quality 90, 4:4:4; decoded sRGB RGB8 metrics',
      maxPsnrDropDb: threshold,
    },
  },
  scenes: {},
};
await mkdir(out, { recursive: true });
const run = async (entry, job, log) => {
  const chunks = [];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'packages/cli/dist', entry), JSON.stringify(job)], {
      cwd: root,
    });
    child.stdout.on('data', (data) => chunks.push(data));
    child.stderr.on('data', (data) => chunks.push(data));
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await writeFile(log, Buffer.concat(chunks));
  if (code !== 0) throw new Error(`GPU job failed (${code}); see ${log}`);
};
const median = (a) => a.toSorted((x, y) => x - y)[Math.floor(a.length / 2)];
for (const scene of scenes) {
  const variants = ['baseline', ...experiments.filter((e) => values.scenes || definitions[e].includes(scene))];
  const row = { timing: {}, quality: {} };
  report.scenes[scene] = row;
  const dir = path.join(out, scene);
  await mkdir(dir, { recursive: true });
  if (!values['skip-timing']) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Alternate order to reduce thermal / clock drift bias. Never run GPU measurements concurrently.
      for (const variant of repeat % 2 ? variants.toReversed() : variants) {
        const file = path.join(dir, `${variant}-timing-${repeat}.json`);
        console.log(`${scene} ${variant}: throughput repeat ${repeat + 1}/${repeats}`);
        await run(
          'bench-process.js',
          {
            renderer: rendererFor(variant),
            hierarchyExperiment: experimentFor(variant),
            scene,
            width,
            height,
            seed: 1,
            motion: 'static',
            orbitDegrees: 30,
            options: {
              protocol: 'throughput',
              durationMs: 1000,
              warmupFrames: warmup,
              measureFrames: measure,
              batchSize: 20,
              cycleFrames: 1,
              stepSeconds: 1 / 60,
            },
            out: file,
          },
          `${file}.log`,
        );
        const result = JSON.parse(await readFile(file, 'utf8')).entry.runs[0];
        (row.timing[variant] ??= { runs: [] }).runs.push(result);
      }
    }
    for (const variant of variants) {
      const result = row.timing[variant];
      result.medianMs = median(
        result.runs.map((r) => r.metrics.find((m) => m.descriptor.id === 'throughput.frame').statistics.mean),
      );
      result.rangeMs = [
        Math.min(
          ...result.runs.map((r) => r.metrics.find((m) => m.descriptor.id === 'throughput.frame').statistics.mean),
        ),
        Math.max(
          ...result.runs.map((r) => r.metrics.find((m) => m.descriptor.id === 'throughput.frame').statistics.mean),
        ),
      ];
      result.speedup = row.timing.baseline.medianMs / result.medianMs;
      const file = path.join(dir, `${variant}-gpu.json`);
      console.log(`${scene} ${variant}: timestamp breakdown`);
      await run(
        'bench-process.js',
        {
          renderer: rendererFor(variant),
          hierarchyExperiment: experimentFor(variant),
          scene,
          width,
          height,
          seed: 1,
          motion: 'static',
          orbitDegrees: 30,
          options: {
            protocol: 'profile',
            durationMs: 1000,
            warmupFrames: Math.min(warmup, 20),
            measureFrames: Math.min(measure, 30),
            batchSize: 1,
            cycleFrames: 1,
            stepSeconds: 1 / 60,
          },
          out: file,
        },
        `${file}.log`,
      );
      result.timestamps = JSON.parse(await readFile(file, 'utf8')).entry.runs[0];
    }
  }
  if (!values['skip-quality']) {
    const referencePath = path.resolve(root, values.references, scene, 'beauty/three-gpu-pathtracer.avif');
    // Missing references are an error: do not silently claim quality success for incomplete evidence.
    const reference = await readRgb(referencePath);
    row.reference = {
      path: path.relative(root, referencePath),
      sha256: createHash('sha256')
        .update(await readFile(referencePath))
        .digest('hex'),
    };
    const captures = {};
    for (const variant of [...variants, 'baseline-repeat']) {
      const repeat = variant === 'baseline-repeat';
      const output = path.join(dir, repeat ? 'repeat' : 'images');
      console.log(`${scene} ${variant}: quality ${frames} frames`);
      await run(
        'render-process.js',
        {
          renderer: rendererFor(variant),
          hierarchyExperiment: repeat ? 'baseline' : experimentFor(variant),
          scenes: [scene],
          frames,
          width: qualityWidth,
          height: qualityHeight,
          samples: 4096,
          outDir: output,
        },
        path.join(dir, `${variant}-quality.log`),
      );
      const label = hierarchyImageName(rendererFor(variant), repeat ? 'baseline' : experimentFor(variant));
      const imagePath = path.join(output, scene, 'beauty', `${label}.avif`);
      const image = await readRgb(imagePath);
      captures[variant] = image;
      const againstReference = compareRgb(reference, image);
      const againstBaseline = compareRgb(captures.baseline, image);
      const baselineMetrics = row.quality.baseline?.reference ?? againstReference.metrics;
      const drop = psnrDrop(baselineMetrics, againstReference.metrics);
      row.quality[variant] = {
        reference: againstReference.metrics,
        baseline: againstBaseline.metrics,
        psnrDropDb: Number.isFinite(drop) ? drop : null,
        image: path.relative(out, imagePath),
      };
      row.quality[variant].passesReferenceGate = drop <= threshold;
      for (const [comparisonName, comparison] of [
        ['reference', againstReference],
        ['baseline', againstBaseline],
      ]) {
        const { data, width: deltaWidth, height: deltaHeight } = comparison.delta;
        await sharp(data, { raw: { width: deltaWidth, height: deltaHeight, channels: 3 } })
          .png()
          .toFile(path.join(dir, `${variant}-vs-${comparisonName}.png`));
      }
    }
    row.baselineRepeatPsnrDb = row.quality['baseline-repeat'].baseline.psnr;
    if (captures['hierarchy-combined']) {
      row.combinedComparisons = {};
      for (const variant of variants.filter((name) => name !== 'hierarchy-combined')) {
        const drop = psnrDrop(row.quality[variant].reference, row.quality['hierarchy-combined'].reference);
        row.combinedComparisons[variant] = {
          psnrDropDb: Number.isFinite(drop) ? drop : null,
          passesReferenceGate: drop <= threshold,
          image: compareRgb(captures[variant], captures['hierarchy-combined']).metrics,
        };
      }
    }
  }
  await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const variant of variants.slice(1)) {
    console.log(
      `${scene} ${variant}: ${row.timing[variant]?.speedup.toFixed(3) ?? 'n/a'}x, reference PSNR ${row.quality[variant] ? (row.quality[variant].reference.psnr?.toFixed(4) ?? '∞') : 'n/a'} dB, gate ${row.quality[variant]?.passesReferenceGate ?? 'n/a'}`,
    );
  }
}
// A report with failed rows must fail automation too, rather than merely print 'gate false'.
report.ok = Object.values(report.scenes).every((row) =>
  [...Object.values(row.quality), ...Object.values(row.combinedComparisons ?? {})].every(
    (variant) => variant.passesReferenceGate,
  ),
);
await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Report: ${path.join(out, 'report.json')}`);
if (!report.ok) process.exitCode = 1;
