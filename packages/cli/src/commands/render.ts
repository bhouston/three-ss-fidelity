import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { passNames, rendererNames } from '@ss-fidelity/renderers';
import { listSceneNames } from '@ss-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { resultsDir } from '../paths.js';
import type { RenderJob } from '../render-process.js';
import { selectNames } from '../select.js';

const renderProcess = fileURLToPath(new URL('../render-process.js', import.meta.url));

// Blender Cycles: a second ground-truth reference renderer, alongside three-gpu-pathtracer. It isn't a `LiveRenderer`
// built by `createRenderer()` (one batch call, not incremental frames), so it's a CLI-layer renderer name, not part
// of `@ss-fidelity/renderers`' `RendererName`.
const cliRendererNames = [...rendererNames, 'blender'] as const;

/** Runs one render-process job; resolves with its exit code. */
export function run(job: RenderJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [renderProcess, JSON.stringify(job)], { stdio: 'inherit' })
      .on('error', reject)
      .on('exit', resolve);
  });
}

function parseMotion(value: string | undefined, objectValue: string | undefined): RenderJob['motion'] {
  if (value === undefined) return undefined;
  const [degrees, moveFrames, ...captures] = value.split(',').map(Number);
  if (degrees === undefined || moveFrames === undefined || captures.length === 0 || captures.some(Number.isNaN)) {
    throw new Error(`--motion expects "degrees,moveFrames,capture,...", got "${value}"`);
  }
  if (objectValue === undefined) return { degrees, moveFrames, captures };
  const [objectName, dx] = objectValue.split(':');
  if (!objectName || dx === undefined || Number.isNaN(Number(dx))) {
    throw new Error(`--motion-object expects "name:dx", got "${objectValue}"`);
  }
  return { degrees, moveFrames, captures, object: { name: objectName, dx: Number(dx) } };
}

export const command = defineCommand({
  command: 'render',
  describe: 'Render scenes with renderers into results/<scene>/<pass>/<renderer>.avif',
  builder: (yargs) =>
    yargs
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('passes', { type: 'string', default: '*', describe: 'Pass name glob(s), comma separated' })
      .option('renderers', { type: 'string', default: '*', describe: 'Renderer name glob(s), comma separated' })
      .option('samples', {
        type: 'number',
        default: 4096,
        describe: 'three-gpu-pathtracer / blender samples per pixel',
      })
      .option('frames', {
        type: 'number',
        describe: 'Screen-space renderer frames (default: each scene’s effects.frames)',
      })
      .option('motion', {
        type: 'string',
        describe:
          'Temporal evaluation "degrees,moveFrames,capture1,capture2,...": orbit back to the scene pose, write <renderer>@m<capture>.avif',
      })
      .option('motion-object', {
        type: 'string',
        describe: 'With --motion, "name:dx": that object also slides back to its position from dx along world x',
      })
      .option('ssr-debug', {
        type: 'string',
        choices: ['hits', 'hitcolor'] as const,
        describe: 'three-new: write the SSR trace debug view as <renderer>@<view>.avif instead of the image',
      })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' }),
  handler: async (argv) => {
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const passes = selectNames(passNames, argv.passes, 'pass') as RenderJob['passes'];
    const renderers = selectNames(cliRendererNames, argv.renderers, 'renderer') as RenderJob['renderer'][];
    let failed = false;
    // one child process per renderer, scene and pass: dawn and ANGLE don't share a process reliably, and GPU state leaked
    // from one scene's renderer into the next scene's (a red cast from ssgi-basic in ssr-steampunk-camera), so no
    // result may depend on what rendered before it
    for (const renderer of renderers) {
      for (const scene of scenes) {
        for (const pass of passes) {
          const code = await run({
            renderer,
            scenes: [scene],
            passes: [pass],
            outDir: argv.output,
            frames: argv.frames,
            samples: argv.samples,
            motion: parseMotion(argv.motion, argv.motionObject),
            ssrDebug: argv.ssrDebug,
          });
          if (code !== 0) {
            console.error(`${scene} | ${pass} | ${renderer} failed (exit code ${code})`);
            failed = true;
          }
        }
      }
    }
    if (failed) process.exitCode = 1;
  },
});
