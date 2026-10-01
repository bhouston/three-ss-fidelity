import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import type { BenchJob, SceneBenchResult } from '../bench-process.js';
import { selectNames } from '../select.js';

const benchProcess = fileURLToPath(new URL('../bench-process.js', import.meta.url));

function run(job: BenchJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [benchProcess, JSON.stringify(job)], { stdio: 'inherit' })
      .on('error', reject)
      .on('exit', resolve);
  });
}

export const command = defineCommand({
  command: 'bench',
  describe:
    'Measure steady-state frame time (ms) per scene for one or more renderers; with exactly two, also report per-scene and mean speedup',
  builder: (yargs) =>
    yargs
      .option('renderers', { type: 'string', demandOption: true, describe: 'Renderer name glob(s), comma separated' })
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('width', { type: 'number', default: 1920 })
      .option('height', { type: 'number', default: 1080 })
      .option('warmup', { type: 'number', default: 60, describe: 'Frames rendered (and GPU-synced) before measuring' })
      .option('measure', { type: 'number', default: 120, describe: 'Frames measured in total, in batches of 20' })
      .option('out', { type: 'string', describe: 'Write the full per-renderer results (and A/B summary) as JSON' })
      .option('gpu', {
        type: 'boolean',
        default: false,
        describe:
          'Screen-space renderers only: report WebGPU timestamp-query GPU ms/frame (total and per named pass) ' +
          'via trackTimestamp, in addition to wall-clock totalMs. Forces a GPU sync every frame, so totalMs is ' +
          'less meaningful in this mode.',
      }),
  handler: async (argv) => {
    const renderers = selectNames(rendererNames, argv.renderers, 'renderer');
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ss-fidelity-bench-'));
    try {
      const results: Record<string, Record<string, SceneBenchResult>> = {};
      let failed = false;
      for (const renderer of renderers) {
        const out = path.join(tmp, `${renderer}.json`);
        // one child process per renderer: dawn and ANGLE don't share a process reliably (see render-process.ts)
        const code = await run({
          renderer: renderer as BenchJob['renderer'],
          scenes,
          width: argv.width,
          height: argv.height,
          warmup: argv.warmup,
          measure: argv.measure,
          out,
          gpu: argv.gpu,
        });
        if (code !== 0) {
          console.error(`${renderer} failed (exit code ${code})`);
          failed = true;
          continue;
        }
        const parsed = JSON.parse(await readFile(out, 'utf8')) as { scenes: Record<string, SceneBenchResult> };
        results[renderer] = parsed.scenes;
      }
      if (failed) {
        process.exitCode = 1;
        return;
      }
      let summary: unknown = results;
      if (renderers.length === 2) {
        const [baseline, candidate] = renderers as [string, string];
        const speedups = scenes.map((scene) => {
          const baselineMs = results[baseline]?.[scene]?.totalMs;
          const candidateMs = results[candidate]?.[scene]?.totalMs;
          return { scene, speedup: baselineMs && candidateMs ? baselineMs / candidateMs : undefined };
        });
        const measured = speedups.filter((row): row is { scene: string; speedup: number } => row.speedup !== undefined);
        const meanSpeedup = measured.reduce((sum, row) => sum + row.speedup, 0) / measured.length;
        console.log(`\n${baseline} -> ${candidate} speedup (>1 means ${candidate} is faster):`);
        for (const row of speedups) console.log(`  ${row.scene}: ${row.speedup ? row.speedup.toFixed(3) : 'n/a'}`);
        console.log(`  mean: ${meanSpeedup.toFixed(3)}`);
        summary = { results, ab: { baseline, candidate, speedups, meanSpeedup } };
      }
      if (argv.out) await writeFile(argv.out, `${JSON.stringify(summary, null, 2)}\n`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
});
