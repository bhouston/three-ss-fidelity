import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { passNames, rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { resultsDir } from '../paths.js';
import type { RenderJob } from '../render-process.js';
import { selectNames } from '../select.js';

const renderProcess = fileURLToPath(new URL('../render-process.js', import.meta.url));

function run(job: RenderJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [renderProcess, JSON.stringify(job)], { stdio: 'inherit' })
      .on('error', reject)
      .on('exit', resolve);
  });
}

function parseMotion(value: string | undefined): RenderJob['motion'] {
  if (value === undefined) return undefined;
  const [degrees, moveFrames, ...captures] = value.split(',').map(Number);
  if (degrees === undefined || moveFrames === undefined || captures.length === 0 || captures.some(Number.isNaN)) {
    throw new Error(`--motion expects "degrees,moveFrames,capture,...", got "${value}"`);
  }
  return { degrees, moveFrames, captures };
}

export const command = defineCommand({
  command: 'render',
  describe: 'Render scenes with renderers into results/<scene>/<pass>/<renderer>.avif',
  builder: (yargs) =>
    yargs
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('passes', { type: 'string', default: '*', describe: 'Pass name glob(s), comma separated' })
      .option('renderers', { type: 'string', default: '*', describe: 'Renderer name glob(s), comma separated' })
      .option('samples', { type: 'number', default: 1024, describe: 'three-gpu-pathtracer samples per pixel' })
      .option('frames', {
        type: 'number',
        describe: 'Screen-space renderer frames (default: each scene’s effects.frames)',
      })
      .option('motion', {
        type: 'string',
        describe:
          'Temporal evaluation "degrees,moveFrames,capture1,capture2,...": orbit back to the scene pose, write <renderer>@m<capture>.avif',
      })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' }),
  handler: async (argv) => {
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const passes = selectNames(passNames, argv.passes, 'pass') as RenderJob['passes'];
    const renderers = selectNames(rendererNames, argv.renderers, 'renderer') as RenderJob['renderer'][];
    let failed = false;
    // one child process per renderer: dawn and ANGLE don't share a process reliably
    for (const renderer of renderers) {
      const code = await run({
        renderer,
        scenes,
        passes,
        outDir: argv.output,
        frames: argv.frames,
        samples: argv.samples,
        motion: parseMotion(argv.motion),
      });
      if (code !== 0) {
        console.error(`${renderer} failed (exit code ${code})`);
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;
  },
});
