import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { hierarchyExperiments, hierarchyImageName, passNames, rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
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
  ...rendererNames.filter((name) => name !== 'three-gpu-pathtracer'),
  ...hierarchyExperiments
    .filter((name) => name !== 'baseline')
    .map((experiment) => hierarchyImageName('three-new', experiment)),
];

export const command = defineCommand({
  command: 'quality-gate <baseline> <candidate>',
  describe:
    'Fail if <candidate> PSNR vs three-gpu-pathtracer drops from <baseline> on any scene/pass by more than --threshold. Run `fidelity-kit process` for both renderers first.',
  builder: (yargs) =>
    yargs
      .positional('baseline', { type: 'string', choices: comparedRenderers })
      .positional('candidate', { type: 'string', choices: comparedRenderers })
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('passes', { type: 'string', default: '*', describe: 'Pass name glob(s), comma separated' })
      .option('threshold', {
        type: 'number',
        default: 0.1,
        describe: 'Max allowed PSNR drop per scene/pass in dB (higher PSNR is better)',
      })
      .option('results', { type: 'string', default: resultsDir, describe: 'Results directory' })
      .option('out', { type: 'string', describe: 'Write the row-by-row and summary result as JSON' }),
  handler: async (argv) => {
    if (!Number.isFinite(argv.threshold) || argv.threshold < 0)
      throw new Error('--threshold must be finite and nonnegative');
    const baseline = argv.baseline!;
    const candidate = argv.candidate!;
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const passes = selectNames(passNames, argv.passes, 'pass');
    const rows: {
      scene: string;
      pass: string;
      baselinePsnr: number | null;
      candidatePsnr: number | null;
      psnrDropDb: number | null;
      ok: boolean;
    }[] = [];
    for (const scene of scenes) {
      for (const pass of passes) {
        const baselinePath = metricsPath(scene, pass, baseline, 'three-gpu-pathtracer', argv.results);
        const candidatePath = metricsPath(scene, pass, candidate, 'three-gpu-pathtracer', argv.results);
        if (!existsSync(baselinePath) || !existsSync(candidatePath)) {
          console.warn(
            `${scene} | ${pass}: skipped, run \`fidelity-kit process\` for ${baseline} and ${candidate} first`,
          );
          continue;
        }
        const baselineMetrics = JSON.parse(await readFile(baselinePath, 'utf8')) as FidelityMetrics;
        const candidateMetrics = JSON.parse(await readFile(candidatePath, 'utf8')) as FidelityMetrics;
        const drop = psnrDrop(baselineMetrics, candidateMetrics);
        rows.push({
          scene,
          pass,
          baselinePsnr: baselineMetrics.psnr,
          candidatePsnr: candidateMetrics.psnr,
          psnrDropDb: Number.isFinite(drop) ? drop : null,
          ok: drop <= argv.threshold,
        });
      }
    }
    if (rows.length === 0)
      throw new Error('No scene/pass had metrics for both renderers; run `fidelity-kit process` first.');

    const ok = rows.every((row) => row.ok);
    for (const row of rows) {
      console.log(
        `${row.scene} | ${row.pass}: ${baseline} PSNR ${row.baselinePsnr?.toFixed(4) ?? '∞'} dB, ${candidate} PSNR ${row.candidatePsnr?.toFixed(4) ?? '∞'} dB: ${row.ok ? 'PASS' : 'FAIL'}`,
      );
    }
    console.log(`Allowed PSNR drop per scene/pass: ${argv.threshold} dB`);
    console.log(ok ? 'QUALITY OK' : 'QUALITY FAIL');
    if (argv.out) {
      await writeFile(
        argv.out,
        `${JSON.stringify({ ok, baseline, candidate, maxPsnrDropDb: argv.threshold, rows }, null, 2)}\n`,
      );
    }
    if (!ok) process.exitCode = 1;
  },
});
