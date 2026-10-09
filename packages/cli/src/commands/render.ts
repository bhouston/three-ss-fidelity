import { renderSuite } from 'fidelity-kit/render';
import registry from '../../../../registry.json' with { type: 'json' };
import { runOnLanes, jobLanes } from '../queues.js';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hierarchyExperiments, hierarchyImageName, rendererNames } from '@three-fidelity/renderers';
import { listSceneNames } from '@three-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { renderPath, resultsDir } from '../paths.js';
import type { RenderJob } from '../render-process.js';
import { selectNames } from '../select.js';

const renderProcess = fileURLToPath(new URL('../render-process.js', import.meta.url));

// Public render names select complete configurations; pipeline options stay internal.
// Baseline retains three-new.avif, while each hierarchy variant keeps its existing filename.
type RenderProfile = Pick<RenderJob, 'renderer' | 'hierarchyExperiment'> & { name: string };
const renderProfiles: RenderProfile[] = [
  ...hierarchyExperiments.map((experiment) => ({
    name: `three-new-${experiment}`,
    renderer: 'three-new' as const,
    hierarchyExperiment: experiment,
  })),
  ...rendererNames.filter((name) => name !== 'three-new').map((renderer) => ({ name: renderer, renderer })),
  { name: 'blender', renderer: 'blender' },
];
const profilesByName = new Map(renderProfiles.map((profile) => [profile.name, profile]));
const cliRendererNames = renderProfiles.map((profile) => profile.name);

/** Runs one render-process job; resolves with its exit code. */
export function run(job: RenderJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [renderProcess, JSON.stringify(job)], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (job.captureLane === 'cpu' && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch (error) {
        console.warn('Unable to lower CPU capture priority:', String(error));
      }
    }
    child.on('error', reject).on('exit', resolve);
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
  describe: 'Render scenes with renderers into fidelity-results/<scene>/beauty/<renderer>.avif',
  builder: (yargs) =>
    yargs
      .strictOptions()
      .option('native', {
        type: 'boolean',
        default: false,
        describe: 'Use native diagnostic backends instead of the shared browser host',
      })
      .option('root-url', { type: 'string', describe: 'Browser render server URL' })
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('renderers', {
        type: 'string',
        describe: `Renderer name glob(s), comma separated. Available: ${cliRendererNames.join(', ')}`,
      })
      .option('width', { type: 'number', describe: 'Override native scene width' })
      .option('height', { type: 'number', describe: 'Override native scene height' })
      .option('samples', {
        type: 'number',
        default: 4096,
        describe: 'three-gpu-pathtracer / blender samples per pixel',
      })
      .option('noise-threshold', {
        type: 'number',
        default: 0,
        describe: 'Path-tracer noise target (0 keeps exact sample counts)',
      })
      .option('min-samples', { type: 'number', default: 128 })
      .option('cycles-noise-threshold', { type: 'number', default: 0 })
      .option('blender-device', { type: 'string', choices: ['auto', 'cpu', 'gpu'] as const, default: 'auto' as const })
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
        describe: 'three-new-*: write the SSR trace debug view as <renderer>@<view>.avif instead of the image',
      })
      .option('missing-only', {
        type: 'boolean',
        default: false,
        describe: 'Skip existing images and render only missing outputs',
      })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' }),
  handler: async (argv) => {
    if (!argv.native) {
      if (argv.motion || argv.ssrDebug || argv.missingOnly || argv.width || argv.height)
        throw new Error('Native diagnostic options require --native');
      return renderSuite({
        registry: 'registry.json',
        rootUrl: argv.rootUrl,
        out: argv.output,
        scene: selectNames(
          registry.scenes.map((s) => s.id),
          argv.scenes,
          'scene',
        ),
        renderer: selectNames(
          registry.renderers.filter((r) => argv.renderers !== undefined || r.enabled !== false).map((r) => r.id),
          argv.renderers ?? '*',
          'renderer',
        ),
        frames: argv.frames,
        captureParams: {
          samples: argv.samples,
          noiseThreshold: argv.noiseThreshold,
          minSamples: argv.minSamples,
          cyclesNoiseThreshold: argv.cyclesNoiseThreshold,
          blenderDevice: argv.blenderDevice,
        },
        externalLane: argv.blenderDevice === 'auto' ? undefined : argv.blenderDevice,
      });
    }
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const enabled = cliRendererNames.filter((name) => {
      const profile = profilesByName.get(name)!;
      const id = hierarchyImageName(profile.renderer, profile.hierarchyExperiment);
      return registry.renderers.some((r) => r.id === id && r.enabled !== false);
    });
    const profiles = selectNames(
      argv.renderers === undefined ? enabled : cliRendererNames,
      argv.renderers ?? '*',
      'renderer',
    ).map((name) => profilesByName.get(name)!);
    let failed = false;
    const pending: { name: string; job: RenderJob }[] = [];
    // one child process per renderer and scene: dawn and ANGLE don't share a process reliably, and GPU state leaked
    // from one scene's renderer into the next scene's (a red cast from cornell-box-basic in steampunk-camera), so no
    // result may depend on what rendered before it
    for (const { name, renderer, hierarchyExperiment } of profiles) {
      for (const scene of scenes) {
        const job: RenderJob = {
          renderer,
          scenes: [scene],
          outDir: argv.output,
          frames: argv.frames,
          width: argv.width,
          height: argv.height,
          samples: argv.samples,
          noiseThreshold: argv.noiseThreshold,
          minSamples: argv.minSamples,
          cyclesNoiseThreshold: argv.cyclesNoiseThreshold,
          blenderDevice: argv.blenderDevice,
          motion: parseMotion(argv.motion, argv.motionObject),
          ssrDebug: argv.ssrDebug,
          hierarchyExperiment,
        };
        if (argv.missingOnly) {
          // Blender rejects these modes in the child process; do not hide those errors by skipping its job.
          if (renderer !== 'blender' || (!job.motion && !job.ssrDebug)) {
            const outputName = hierarchyImageName(renderer, job.hierarchyExperiment);
            if (job.motion) {
              // Keep the full frame progression; only remove capture writes for images already on disk.
              job.motion.captures = job.motion.captures.filter(
                (frame) => !existsSync(renderPath(scene, `${outputName}@m${frame}`, job.outDir)),
              );
              if (job.motion.captures.length === 0) {
                console.log(`${scene} | ${name}: skipped (images already exist)`);
                continue;
              }
            } else {
              const imageName = job.ssrDebug ? `${outputName}@${job.ssrDebug}` : outputName;
              if (existsSync(renderPath(scene, imageName, job.outDir))) {
                console.log(`${scene} | ${name}: skipped (image already exists)`);
                continue;
              }
            }
          }
        }
        pending.push({ name, job });
      }
    }
    await runOnLanes(
      pending,
      ({ job }) => {
        const required = registry.scenes.find((s) => s.id === job.scenes[0])?.externalCaptureLane;
        if (job.renderer === 'blender' && required === 'gpu') {
          if (argv.blenderDevice === 'cpu')
            throw new Error('Scene requires GPU environment export; select auto or gpu');
          return ['gpu'];
        }
        return jobLanes(job.renderer, argv.blenderDevice);
      },
      async ({ name, job }, lane) => {
        try {
          const code = await run({ ...job, captureLane: lane });
          if (code !== 0) {
            console.error(`${job.scenes[0]} | ${name} failed (exit code ${code})`);
            failed = true;
          }
        } catch (error) {
          console.error(`${job.scenes[0]} | ${name} failed to start`, error);
          failed = true;
        }
      },
    );
    if (failed) process.exitCode = 1;
  },
});
