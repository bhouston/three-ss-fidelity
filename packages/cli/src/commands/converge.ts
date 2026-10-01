import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { readRgb } from '../compare.js';
import { summarize, type ConvergeFile, type ConvergeSummary } from '../converge.js';
import { passDir, renderPath, resultsDir } from '../paths.js';
import type { RenderJob } from '../render-process.js';
import { selectNames } from '../select.js';
import { run } from './render.js';

const CAPTURES = [0, 1, 2, 4, 8, 16, 32, 64, 128, 255, 256];
const screenSpaceRenderers = rendererNames.filter((name) => name !== 'three-gpu-pathtracer');

export const command = defineCommand({
  command: 'converge',
  describe:
    'Move-then-stop benchmark: orbit into the reference pose, then score frames after stopping against three-gpu-pathtracer (results/<scene>/beauty/converge-<renderer>.json)',
  builder: (yargs) =>
    yargs
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('renderers', {
        type: 'string',
        default: '*',
        describe: 'Screen-space renderer name glob(s), comma separated',
      })
      .option('degrees', { type: 'number', default: 15, describe: 'Camera orbit (about world Y) into the pose' })
      .option('move-frames', { type: 'number', default: 90, describe: 'Frames the orbit takes' })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' }),
  handler: async (argv) => {
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const renderers = selectNames(screenSpaceRenderers, argv.renderers, 'renderer') as RenderJob['renderer'][];
    const motion = { degrees: argv.degrees, moveFrames: argv.moveFrames };
    const rows: { scene: string; renderer: string; summary: ConvergeSummary }[] = [];
    const captureDir = await mkdtemp(path.join(tmpdir(), 'ss-fidelity-converge-'));
    try {
      for (const renderer of renderers) {
        for (const scene of scenes) {
          const reference = renderPath(scene, 'beauty', 'three-gpu-pathtracer', argv.output);
          if (!existsSync(reference)) {
            console.warn(`${scene}: skipped, no three-gpu-pathtracer reference`);
            continue;
          }
          const code = await run({
            renderer,
            scenes: [scene],
            passes: ['beauty'],
            outDir: captureDir,
            samples: 0,
            motion: { ...motion, captures: CAPTURES },
          });
          if (code !== 0) {
            console.error(`${scene} | ${renderer} failed (exit code ${code})`);
            process.exitCode = 1;
            continue;
          }
          const captures = await Promise.all(
            CAPTURES.map(async (frame) => ({
              frame,
              image: await readRgb(renderPath(scene, 'beauty', `${renderer}@m${frame}`, captureDir)),
            })),
          );
          const { samples, summary } = summarize(await readRgb(reference), captures);
          const file: ConvergeFile = {
            scene,
            renderer,
            motion,
            samples,
            summary,
            generatedAt: new Date().toISOString(),
          };
          await writeFile(
            path.join(passDir(scene, 'beauty', argv.output), `converge-${renderer}.json`),
            `${JSON.stringify(file, null, 2)}\n`,
          );
          rows.push({ scene, renderer, summary });
          console.log(`${scene} | ${renderer}: ${formatSummary(summary)}`);
        }
      }
    } finally {
      await rm(captureDir, { recursive: true, force: true });
    }

    for (const renderer of renderers) {
      const own = rows.filter((row) => row.renderer === renderer).map((row) => row.summary);
      if (own.length === 0) continue;
      const mean = Object.fromEntries(
        (Object.keys(own[0]!) as (keyof ConvergeSummary)[]).map((key) => [
          key,
          own.reduce((sum, summary) => sum + (summary[key] ?? Infinity), 0) / own.length,
        ]),
      ) as unknown as ConvergeSummary;
      console.log(`mean | ${renderer} (${own.length} scenes): ${formatSummary(mean)}`);
    }
  },
});

function formatSummary(s: ConvergeSummary): string {
  return (
    `PSNR (dB) at stop ${s.atStop?.toFixed(4) ?? '∞'}, +16 ${s.after16?.toFixed(4) ?? '∞'}, final ${s.final?.toFixed(4) ?? '∞'}; ` +
    `bias ${(s.finalBias * 100).toFixed(1)}%, flicker ${s.flicker?.toFixed(4) ?? '∞'}`
  );
}
