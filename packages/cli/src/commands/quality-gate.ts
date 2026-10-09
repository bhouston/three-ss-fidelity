import { relativeMeanRmse } from '../quality-policy.js';
import registry from '../../../../registry.json' with { type: 'json' };
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { hierarchyExperiments, hierarchyImageName, rendererNames } from '@three-fidelity/renderers';
import { listSceneNames } from '@three-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { metricsPath, resultsDir } from '../paths.js';
import { selectNames } from '../select.js';
import { psnrDrop } from '../compare.js';

/** `fidelity-kit process`'s `<renderer>.vs-<reference>.metrics.json`. */
interface FidelityMetrics {
  psnr: number | null;
  width: number;
  height: number;
  generatedAt: string;
}

// Every screen-space renderer (everything but the path-traced reference itself).
const comparedRenderers = [
  'blender',
  ...rendererNames,
  ...hierarchyExperiments
    .filter((name) => name !== 'baseline')
    .map((experiment) => hierarchyImageName('three-new', experiment)),
];

export const command = defineCommand({
  command: 'quality-gate <baseline> <candidate>',
  describe:
    'Fail if <candidate> PSNR vs three-gpu-pathtracer drops from <baseline> on any scene by more than --threshold. Run `fidelity-kit process` for both renderers first.',
  builder: (yargs) =>
    yargs
      .positional('baseline', { type: 'string', choices: comparedRenderers })
      .positional('candidate', { type: 'string', choices: comparedRenderers })
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('reference', {
        type: 'string',
        default: 'three-gpu-pathtracer',
        choices: registry.renderers.filter((r) => r.reference).map((r) => r.id),
      })
      .option('policy', { type: 'string', choices: ['psnr', 'rmse'] as const, default: 'psnr' as const })
      .option('threshold', {
        type: 'number',
        describe: 'Allowed regression: PSNR dB (default 0.1) or relative mean RMSE (default 0.01)',
      })
      .option('results', { type: 'string', default: resultsDir, describe: 'Results directory' })
      .option('out', { type: 'string', describe: 'Write the row-by-row and summary result as JSON' }),
  handler: async (argv) => {
    const threshold = argv.threshold ?? (argv.policy === 'rmse' ? 0.01 : 0.1);
    if (!Number.isFinite(threshold) || threshold < 0) throw new Error('--threshold must be finite and nonnegative');
    const baseline = argv.baseline!;
    const candidate = argv.candidate!;
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const rows: {
      scene: string;
      baselinePsnr: number | null;
      candidatePsnr: number | null;
      psnrDropDb: number | null;
      ok?: boolean;
    }[] = [];
    for (const scene of scenes) {
      const baselinePath = metricsPath(scene, baseline, argv.reference, argv.results);
      const candidatePath = metricsPath(scene, candidate, 'three-gpu-pathtracer', argv.results);
      if (!existsSync(baselinePath) || !existsSync(candidatePath)) {
        console.warn(`${scene}: skipped, run \`fidelity-kit process\` for ${baseline} and ${candidate} first`);
        continue;
      }
      const baselineMetrics = JSON.parse(await readFile(baselinePath, 'utf8')) as FidelityMetrics;
      const candidateMetrics = JSON.parse(await readFile(candidatePath, 'utf8')) as FidelityMetrics;
      const drop = psnrDrop(baselineMetrics, candidateMetrics);
      rows.push({
        scene,
        baselinePsnr: baselineMetrics.psnr,
        candidatePsnr: candidateMetrics.psnr,
        psnrDropDb: Number.isFinite(drop) ? drop : null,
        ok: argv.policy === 'psnr' ? drop <= threshold : undefined,
      });
    }
    if (rows.length === 0)
      throw new Error('No scene had metrics for both renderers; run `fidelity-kit process` first.');

    const rmse = relativeMeanRmse(rows);
    const ok = argv.policy === 'rmse' ? rmse.regression <= threshold : rows.every((row) => row.ok);
    for (const row of rows) {
      console.log(
        `${row.scene}: ${baseline} PSNR ${row.baselinePsnr?.toFixed(4) ?? '∞'} dB, ${candidate} PSNR ${row.candidatePsnr?.toFixed(4) ?? '∞'} dB${argv.policy === 'psnr' ? `: ${row.ok ? 'PASS' : 'FAIL'}` : ''}`,
      );
    }
    console.log(
      argv.policy === 'rmse'
        ? `Relative mean RMSE regression: ${rmse.regression}; allowed ${threshold}`
        : `Allowed PSNR drop per scene: ${threshold} dB`,
    );
    console.log(ok ? 'QUALITY OK' : 'QUALITY FAIL');
    if (argv.out) {
      await writeFile(
        argv.out,
        `${JSON.stringify({ ok, baseline, candidate, reference: argv.reference, policy: argv.policy, threshold, rmse: argv.policy === 'rmse' ? rmse : undefined, maxPsnrDropDb: argv.policy === 'psnr' ? threshold : undefined, rows }, null, 2)}\n`,
      );
    }
    if (!ok) process.exitCode = 1;
  },
});
