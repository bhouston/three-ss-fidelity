// One scene/renderer/repetition per process: fresh GPU state, compilation excluded from measurement.
import { writeFile } from 'node:fs/promises';
import { benchmark, seededRandom } from '@ss-fidelity/runtime';
import type { BenchmarkOptions, ReportEntry } from '@ss-fidelity/runtime';
import type { HierarchyExperiment, RendererName } from '@ss-fidelity/renderers';

export interface BenchJob {
  renderer: RendererName;
  scene: string;
  width: number;
  height: number;
  seed: number;
  motion: 'static' | 'orbit';
  orbitDegrees: number;
  hierarchyExperiment: HierarchyExperiment;
  options: BenchmarkOptions;
  out: string;
}

async function main(job: BenchJob): Promise<void> {
  const headless =
    job.renderer === 'three-gpu-pathtracer'
      ? await import('./headless/webgl.js')
      : await import('./headless/webgpu.js');
  headless.install();
  const { createRenderer, completeRenderer, createRendererFrameDriver } = await import('@ss-fidelity/renderers');
  const { getScene, disposeSceneSetup, createOrbitWorkload } = await import('@ss-fidelity/scenes');
  const { createNodeSceneContext } = await import('@ss-fidelity/scenes/node');
  const ctx = createNodeSceneContext();
  let settings: unknown;
  let adapter: unknown;
  const originalRandom = Math.random;
  try {
    const run = await benchmark(
      async () => {
        Math.random = seededRandom(job.seed);
        const setup = await getScene(job.scene).create(ctx);
        settings = structuredClone(setup.effects);
        const canvas = headless.createCanvas(job.width, job.height);
        let live;
        try {
          live = await createRenderer(job.renderer, canvas, setup, {
            width: job.width,
            height: job.height,
            trackTimestamp: job.options.protocol === 'profile',
            hierarchyExperiment: job.hierarchyExperiment,
          });
        } catch (error) {
          disposeSceneSetup(setup);
          throw error;
        }
        const renderer = live;
        const advance = createRendererFrameDriver(renderer.renderer);
        const device = (renderer.renderer as unknown as { backend?: { device?: { adapterInfo?: unknown } } }).backend
          ?.device;
        adapter = device?.adapterInfo ?? {
          backend: job.renderer === 'three-gpu-pathtracer' ? 'WebGL/ANGLE' : 'WebGPU/Dawn',
        };
        const orbit =
          job.motion === 'orbit' ? createOrbitWorkload(setup, job.options.cycleFrames, job.orbitDegrees) : undefined;
        return {
          pipeline: renderer,
          beforeFrame(frame) {
            advance(frame);
            if (orbit) {
              orbit(frame.index);
              renderer.setCamera(setup.camera);
            }
          },
          complete: () => completeRenderer(renderer.renderer),
          dispose() {
            try {
              renderer.dispose();
            } finally {
              disposeSceneSetup(setup);
            }
          },
        };
      },
      job.options,
      { now: () => performance.now(), yield: () => new Promise((resolve) => setImmediate(resolve)) },
    );
    const entry: ReportEntry = {
      scene: job.scene,
      renderer: job.renderer,
      experiment: job.hierarchyExperiment,
      workload: {
        width: job.width,
        height: job.height,
        seed: job.seed,
        motion: job.motion,
        orbitDegrees: job.orbitDegrees,
        settings,
        history: 'fresh-session-then-warmup',
      },
      runs: [run],
    };
    await writeFile(job.out, `${JSON.stringify({ entry, adapter }, null, 2)}\n`);
  } finally {
    Math.random = originalRandom;
  }
}

try {
  await main(JSON.parse(process.argv[2]!) as BenchJob);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
