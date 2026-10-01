import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareEntries, primaryMetric, validateBenchmarkOptions, reportHtml } from '@ss-fidelity/runtime';
import type { BenchmarkOptions, BenchmarkReport, ReportEntry } from '@ss-fidelity/runtime';
import { hierarchyExperiments, rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import type { BenchJob } from '../bench-process.js';
import { selectNames } from '../select.js';
import { repoRoot } from '../paths.js';

const benchProcess = fileURLToPath(new URL('../bench-process.js', import.meta.url));

function run(job: BenchJob): Promise<void> {
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [benchProcess, JSON.stringify(job)], { stdio: 'inherit' })
      .on('error', reject)
      .on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${job.renderer} / ${job.scene} exited ${code}`)),
      );
  });
}

function revision(args: string[]): string {
  try {
    return execFileSync('git-dedup', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

export const command = defineCommand({
  command: 'bench',
  describe:
    'Run seeded, repeated completed-work benchmarks or instrumented GPU profiles; save JSON and a standalone HTML report',
  builder: (yargs) =>
    yargs
      .option('renderers', {
        type: 'string',
        demandOption: true,
        describe: 'Renderer name glob(s), comma separated; first is baseline',
      })
      .option('experiment', {
        type: 'string',
        choices: hierarchyExperiments,
        default: 'baseline',
        describe: 'three-new pipeline experiment',
      })
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('width', { type: 'number', default: 1920 })
      .option('height', { type: 'number', default: 1080 })
      .option('warmup', { type: 'number', default: 60, describe: 'Warmup frames outside measurement' })
      .option('duration', { type: 'number', default: 5, describe: 'Minimum measured seconds per repetition' })
      .option('repeats', { type: 'number', default: 5, describe: 'Fresh repetitions; renderer order alternates' })
      .option('measure', { type: 'number', describe: 'Exact measured frame budget instead of duration (smoke tests)' })
      .option('batch', {
        type: 'number',
        default: 20,
        describe: 'Frames per GPU completion boundary in throughput mode',
      })
      .option('seed', { type: 'number', default: 1 })
      .option('motion', { type: 'string', choices: ['static', 'orbit'], default: 'static' })
      .option('cycle', {
        type: 'number',
        default: 120,
        describe: 'Frames per closed orbit; duration runs finish complete cycles',
      })
      .option('orbit-degrees', { type: 'number', default: 30 })
      .option('profile', {
        type: 'boolean',
        default: false,
        describe: 'Instrument GPU queries with per-frame synchronization; separate from throughput',
      })
      .option('gpu', { type: 'boolean', default: false, describe: 'Compatibility alias for --profile' })
      .option('out', { type: 'string', describe: 'Report JSON path; defaults to benchmarks/<run-id>/report.json' }),
  handler: async (argv) => {
    const renderers = [
      ...new Set(argv.renderers.split(',').flatMap((pattern) => selectNames(rendererNames, pattern, 'renderer'))),
    ];
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    if (![argv.width, argv.height, argv.repeats].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new Error('Dimensions and repeats must be positive integers');
    if (!Number.isSafeInteger(argv.seed) || !Number.isFinite(argv.orbitDegrees))
      throw new Error('Seed must be an integer and orbit-degrees must be finite');
    if (argv.experiment !== 'baseline' && renderers.some((name) => name !== 'three-new'))
      throw new Error('--experiment requires --renderers three-new');
    const options: BenchmarkOptions = {
      protocol: argv.profile || argv.gpu ? 'profile' : 'throughput',
      durationMs: argv.duration * 1000,
      warmupFrames: argv.warmup,
      batchSize: argv.batch,
      measureFrames: argv.measure,
      cycleFrames: argv.motion === 'orbit' ? argv.cycle : 1,
      stepSeconds: 1 / 60,
    };
    validateBenchmarkOptions(options);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const report: BenchmarkReport = {
      schemaVersion: 1,
      id,
      generatedAt: new Date().toISOString(),
      environment: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        runtime: process.version,
        cpu: os.cpus()[0]?.model,
        adapters: {},
      },
      provenance: {
        revision: revision(['rev-parse', 'HEAD']),
        dirty: revision(['status', '--porcelain']) !== '',
        submodules: revision(['submodule', 'status']),
        order: 'alternating-renderer-order; fresh process per scene/renderer/repetition',
      },
      entries: [],
    };
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ss-fidelity-bench-'));
    try {
      for (let repetition = 0; repetition < argv.repeats; repetition++) {
        const order = repetition % 2 ? renderers.toReversed() : renderers;
        for (const scene of scenes)
          for (const renderer of order) {
            console.log(`${scene} | ${renderer} | ${options.protocol} | repetition ${repetition + 1}/${argv.repeats}`);
            const out = path.join(tmp, 'run.json');
            await run({
              renderer: renderer as BenchJob['renderer'],
              scene,
              width: argv.width,
              height: argv.height,
              seed: argv.seed,
              motion: argv.motion as BenchJob['motion'],
              orbitDegrees: argv.orbitDegrees,
              hierarchyExperiment: argv.experiment as BenchJob['hierarchyExperiment'],
              options,
              out,
            });
            const parsed = JSON.parse(await readFile(out, 'utf8')) as { entry: ReportEntry; adapter: unknown };
            const existing = report.entries.find((entry) => entry.scene === scene && entry.renderer === renderer);
            if (existing) existing.runs.push(...parsed.entry.runs);
            else report.entries.push(parsed.entry);
            (report.environment.adapters as Record<string, unknown>)[renderer] = parsed.adapter;
            const measured = parsed.entry.runs[0]!;
            const metric = measured.metrics.find((value) => value.descriptor.id === primaryMetric(options.protocol))!;
            console.log(
              `  ${metric.statistics.mean.toFixed(3)} ms/frame (${metric.sampleUnit} samples), ${measured.fps.toFixed(1)} ${options.protocol === 'profile' ? 'synchronized' : 'completed-work'} FPS`,
            );
            if (measured.profiling.status === 'unsupported')
              console.log(`  GPU timing unavailable: ${measured.profiling.reason}`);
          }
      }
      report.comparisons = [];
      if (renderers.length === 2)
        for (const scene of scenes) {
          const base = report.entries.find((entry) => entry.scene === scene && entry.renderer === renderers[0])!;
          const next = report.entries.find((entry) => entry.scene === scene && entry.renderer === renderers[1])!;
          const comparison = compareEntries(base, next);
          report.comparisons.push(comparison);
          console.log(
            `${scene}: ${comparison.speedup.mean.toFixed(3)}× speedup (repetition stddev ${comparison.speedup.stddev.toFixed(3)}; >1 is faster)`,
          );
        }
      const out = path.resolve(argv.out ?? path.join(repoRoot, 'benchmarks', id, 'report.json'));
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
      const html = out.replace(/\.json$/i, '') + '.html';
      await writeFile(html, reportHtml(report));
      console.log(`JSON: ${out}\nReport: ${html}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
});
