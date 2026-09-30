import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { passNames, rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { compareImages, type MetricsFile } from '../compare.js';
import { comparisonPaths, renderPath, resultsDir } from '../paths.js';
import { selectNames } from '../select.js';

// Blender Cycles is a second ground-truth reference (like three-gpu-pathtracer), not a screen-space renderer: it can be
// the --reference, or explicitly compared (e.g. --reference three-gpu-pathtracer --renderers blender), but it's
// excluded from the default screen-space renderer set below.
const compareRendererNames = [...rendererNames, 'blender'] as const;
const referenceRenderers = ['three-gpu-pathtracer', 'blender'] as const;
// Every screen-space renderer: everything but the two ground-truth/reference renderers.
const screenSpaceRenderers = compareRendererNames.filter(
  (name): name is Exclude<(typeof compareRendererNames)[number], (typeof referenceRenderers)[number]> =>
    !(referenceRenderers as readonly string[]).includes(name),
);

export const command = defineCommand({
  command: 'compare',
  describe: 'Compare renderers against a reference (three-gpu-pathtracer by default)',
  builder: (yargs) =>
    yargs
      .option('scenes', {
        type: 'string',
        default: '*',
        describe: 'Comma-separated scene name globs',
      })
      .option('passes', { type: 'string', default: '*', describe: 'Comma-separated pass name globs' })
      .option('reference', {
        type: 'string',
        default: 'three-gpu-pathtracer',
        choices: referenceRenderers,
        describe: 'Reference (ground-truth) renderer to compare against',
      })
      .option('renderers', {
        type: 'string',
        default: '*',
        describe:
          'Renderer name glob(s) to compare against --reference, comma separated (default: the screen-space renderers, plus the other reference when --reference is set)',
      })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' }),
  handler: async (argv) => {
    const passes = selectNames(passNames, argv.passes, 'pass');
    const reference = argv.reference;
    // Comparing against the default reference: default to the screen-space renderers, as before. Comparing against a
    // non-default reference (blender): default to everything but that reference itself, so e.g. `--reference blender`
    // also compares it against three-gpu-pathtracer.
    const selectable =
      argv.renderers === '*' && reference === 'three-gpu-pathtracer'
        ? screenSpaceRenderers
        : compareRendererNames.filter((name) => name !== reference);
    const renderers = selectNames(selectable, argv.renderers, 'renderer');
    for (const scene of selectNames(listSceneNames(), argv.scenes, 'scene')) {
      for (const pass of passes) {
        const referenceFile = renderPath(scene, pass, reference, argv.output);
        for (const renderer of renderers) {
          const test = renderPath(scene, pass, renderer, argv.output);
          const missing = [referenceFile, test].filter((file) => !existsSync(file));
          if (missing.length > 0) {
            console.warn(
              `${scene} | ${pass} | ${renderer}: skipped, missing ${missing.map((file) => path.basename(file)).join(', ')}`,
            );
            continue;
          }
          const { metrics, width, height, deltaImage } = await compareImages(referenceFile, test);
          const file: MetricsFile = {
            scene,
            pass,
            reference,
            test: renderer,
            width,
            height,
            ...metrics,
            generatedAt: new Date().toISOString(),
          };
          const paths = comparisonPaths(scene, pass, renderer, argv.output, reference);
          await writeFile(paths.delta, deltaImage);
          await writeFile(paths.metrics, `${JSON.stringify(file, null, 2)}\n`);
          console.log(
            `${scene} | ${pass} | ${renderer} vs ${reference}: PSNR ${metrics.psnr?.toFixed(2) ?? '∞'} dB, RMSE ${metrics.rmse.toFixed(4)}`,
          );
        }
      }
    }
  },
});
