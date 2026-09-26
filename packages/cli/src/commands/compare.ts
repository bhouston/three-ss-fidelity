import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { passNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { compareImages, type MetricsFile } from '../compare.js';
import { comparisonPaths, renderPath, resultsDir } from '../paths.js';
import { selectNames } from '../select.js';

const comparedRenderers = ['three-ss', 'three-ss-legacy'] as const;

export const command = defineCommand({
  command: 'compare',
  describe: 'Compare screen-space renderers against three-gpu-pathtracer',
  builder: (yargs) =>
    yargs
      .option('scenes', {
        type: 'string',
        default: '*',
        describe: 'Comma-separated scene name globs',
      })
      .option('passes', { type: 'string', default: '*', describe: 'Comma-separated pass name globs' })
      .option('renderers', {
        type: 'string',
        default: '*',
        describe: 'Screen-space renderer name glob(s), comma separated',
      })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' }),
  handler: async (argv) => {
    const passes = selectNames(passNames, argv.passes, 'pass');
    const renderers = selectNames(
      comparedRenderers,
      argv.renderers,
      'renderer',
    ) as (typeof comparedRenderers)[number][];
    for (const scene of selectNames(listSceneNames(), argv.scenes, 'scene')) {
      for (const pass of passes) {
        const reference = renderPath(scene, pass, 'three-gpu-pathtracer', argv.output);
        for (const renderer of renderers) {
          const test = renderPath(scene, pass, renderer, argv.output);
          const missing = [reference, test].filter((file) => !existsSync(file));
          if (missing.length > 0) {
            console.warn(
              `${scene} | ${pass} | ${renderer}: skipped, missing ${missing.map((file) => path.basename(file)).join(', ')}`,
            );
            continue;
          }
          const { metrics, width, height, deltaPng } = await compareImages(reference, test);
          const file: MetricsFile = {
            scene,
            pass,
            reference: 'three-gpu-pathtracer',
            test: renderer,
            width,
            height,
            ...metrics,
            generatedAt: new Date().toISOString(),
          };
          const paths = comparisonPaths(scene, pass, renderer, argv.output);
          await writeFile(paths.delta, deltaPng);
          await writeFile(paths.metrics, `${JSON.stringify(file, null, 2)}\n`);
          console.log(
            `${scene} | ${pass} | ${renderer}: PSNR ${metrics.psnr?.toFixed(2) ?? '∞'} dB, RMSE ${metrics.rmse.toFixed(4)}`,
          );
        }
      }
    }
  },
});
