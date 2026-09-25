import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { passNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { compareImages, type MetricsFile } from '../compare.js';
import { passDir, renderPath } from '../paths.js';
import { selectNames } from '../select.js';

export const command = defineCommand({
  command: 'compare',
  describe: 'Compare three-ss against three-gpu-pathtracer: writes results/<scene>/<pass>/delta.png and metrics.json',
  builder: (yargs) =>
    yargs
      .option('scenes', {
        type: 'string',
        default: '*',
        describe: 'Comma-separated scene name globs',
      })
      .option('passes', { type: 'string', default: '*', describe: 'Comma-separated pass name globs' }),
  handler: async (argv) => {
    const passes = selectNames(passNames, argv.passes, 'pass');
    for (const scene of selectNames(listSceneNames(), argv.scenes, 'scene')) {
      for (const pass of passes) {
        const reference = renderPath(scene, pass, 'three-gpu-pathtracer');
        const test = renderPath(scene, pass, 'three-ss');
        const missing = [reference, test].filter((file) => !existsSync(file));
        if (missing.length > 0) {
          console.warn(`${scene} | ${pass}: skipped, missing ${missing.map((file) => path.basename(file)).join(', ')}`);
          continue;
        }
        const { metrics, width, height, deltaPng } = await compareImages(reference, test);
        const file: MetricsFile = {
          scene,
          pass,
          reference: 'three-gpu-pathtracer',
          test: 'three-ss',
          width,
          height,
          ...metrics,
          generatedAt: new Date().toISOString(),
        };
        const dir = passDir(scene, pass);
        await writeFile(path.join(dir, 'delta.png'), deltaPng);
        await writeFile(path.join(dir, 'metrics.json'), `${JSON.stringify(file, null, 2)}\n`);
        console.log(`${scene} | ${pass}: PSNR ${metrics.psnr?.toFixed(2) ?? '∞'} dB, RMSE ${metrics.rmse.toFixed(4)}`);
      }
    }
  },
});
