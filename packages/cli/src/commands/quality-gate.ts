import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { passNames, rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import type { MetricsFile } from '../compare.js';
import { comparisonPaths, resultsDir } from '../paths.js';
import { selectNames } from '../select.js';

// Every screen-space renderer (everything but the path-traced reference itself).
const comparedRenderers = rendererNames.filter((name) => name !== 'three-gpu-pathtracer');

export const command = defineCommand({
  command: 'quality-gate <baseline> <candidate>',
  describe:
    'Fail if <candidate> mean RMSE vs three-gpu-pathtracer regresses on <baseline> by more than --threshold. Run `cli compare` for both renderers first.',
  builder: (yargs) =>
    yargs
      .positional('baseline', { type: 'string', choices: comparedRenderers })
      .positional('candidate', { type: 'string', choices: comparedRenderers })
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('passes', { type: 'string', default: '*', describe: 'Pass name glob(s), comma separated' })
      .option('threshold', {
        type: 'number',
        default: 0.01,
        describe: 'Max allowed relative mean-RMSE regression, e.g. 0.01 = 1%',
      })
      .option('results', { type: 'string', default: resultsDir, describe: 'Results directory' })
      .option('out', { type: 'string', describe: 'Write the row-by-row and summary result as JSON' }),
  handler: async (argv) => {
    const baseline = argv.baseline!;
    const candidate = argv.candidate!;
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const passes = selectNames(passNames, argv.passes, 'pass');
    const rows: { scene: string; pass: string; baselineRmse: number; candidateRmse: number }[] = [];
    for (const scene of scenes) {
      for (const pass of passes) {
        const baselinePath = comparisonPaths(scene, pass, baseline, argv.results).metrics;
        const candidatePath = comparisonPaths(scene, pass, candidate, argv.results).metrics;
        if (!existsSync(baselinePath) || !existsSync(candidatePath)) {
          console.warn(`${scene} | ${pass}: skipped, run \`cli compare\` for ${baseline} and ${candidate} first`);
          continue;
        }
        const baselineMetrics = JSON.parse(await readFile(baselinePath, 'utf8')) as MetricsFile;
        const candidateMetrics = JSON.parse(await readFile(candidatePath, 'utf8')) as MetricsFile;
        rows.push({ scene, pass, baselineRmse: baselineMetrics.rmse, candidateRmse: candidateMetrics.rmse });
      }
    }
    if (rows.length === 0) throw new Error('No scene/pass had metrics for both renderers; run `cli compare` first.');

    const mean = (key: 'baselineRmse' | 'candidateRmse') => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
    const baselineMean = mean('baselineRmse');
    const candidateMean = mean('candidateRmse');
    const regression = (candidateMean - baselineMean) / baselineMean;
    const ok = regression <= argv.threshold;

    for (const row of rows) {
      console.log(
        `${row.scene} | ${row.pass}: ${baseline} RMSE ${row.baselineRmse.toFixed(4)}, ${candidate} RMSE ${row.candidateRmse.toFixed(4)}`,
      );
    }
    console.log(
      `mean RMSE: ${baseline} ${baselineMean.toFixed(4)} -> ${candidate} ${candidateMean.toFixed(4)} ` +
        `(${(regression * 100).toFixed(2)}% regression, threshold ${(argv.threshold * 100).toFixed(0)}%)`,
    );
    console.log(ok ? 'QUALITY OK' : 'QUALITY FAIL');
    if (argv.out) {
      await writeFile(
        argv.out,
        `${JSON.stringify({ ok, baseline, candidate, baselineMean, candidateMean, regression, rows }, null, 2)}\n`,
      );
    }
    if (!ok) process.exitCode = 1;
  },
});
