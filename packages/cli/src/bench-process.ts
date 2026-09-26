// Child process entry of `cli bench`: measures one renderer's steady-state frame time across scenes. Each GPU
// backend (dawn, ANGLE) gets its own process, matching render-process.ts, and the process exits explicitly.
import { writeFile } from 'node:fs/promises';
import type { PassName, RendererName } from '@ss-fidelity/renderers';

export interface BenchJob {
  renderer: RendererName;
  scenes: string[];
  pass: PassName;
  width: number;
  height: number;
  /** Frames rendered (and GPU-synced) before measuring, so shader compilation and temporal history settle. */
  warmup: number;
  /** Frames measured in total, in batches of BATCH back-to-back submits per GPU sync. */
  measure: number;
  /** Where to write this renderer's { renderer, pass, scenes } JSON. */
  out: string;
}

export interface SceneBenchResult {
  /** Median ms/frame of a GPU-synced batch: steady-state wall time, not just CPU submit time. */
  totalMs: number;
  /** Median ms/frame of CPU time spent inside render() (robust to OS scheduling contention). */
  cpuMs: number;
}

const BATCH = 20;
const median = (values: number[]): number => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function main(job: BenchJob): Promise<void> {
  const screenSpace = job.renderer !== 'three-gpu-pathtracer';
  const headless = screenSpace ? await import('./headless/webgpu.js') : await import('./headless/webgl.js');
  headless.install();
  const { createRenderer } = await import('@ss-fidelity/renderers');
  const { getScene } = await import('@ss-fidelity/scenes');
  const { createNodeSceneContext } = await import('@ss-fidelity/scenes/node');
  const ctx = createNodeSceneContext();
  const results: Record<string, SceneBenchResult> = {};

  for (const name of job.scenes) {
    const setup = await getScene(name).create(ctx);
    const canvas = headless.createCanvas(job.width, job.height);
    const live = await createRenderer(job.renderer, canvas, setup, {
      width: job.width,
      height: job.height,
      pass: job.pass,
    });
    await headless.ready();
    // GPU queue sync: dawn (WebGPU) exposes the actual submitted work; the WebGL (ANGLE) backend used for
    // three-gpu-pathtracer has no such API here, so a pixel readback (already synchronous) stands in for it.
    const sync = screenSpace
      ? () =>
          (live.renderer as unknown as { backend: { device: GPUDevice } }).backend.device.queue.onSubmittedWorkDone()
      : () => headless.readPixels(canvas);

    for (let i = 0; i < job.warmup; i++) {
      live.render();
      await sync();
      await new Promise((resolve) => setImmediate(resolve)); // async shader compilation
    }

    // The node frame (and with it every effect pass) only advances in the renderer's animation loop, which the
    // headless requestAnimationFrame runs from a timer, so each frame must yield to it: back-to-back render()
    // calls without yielding would re-run only the final output pass. See live.frames check below.
    const cpu: number[] = [];
    const total: number[] = [];
    for (let batch = 0; batch < Math.ceil(job.measure / BATCH); batch++) {
      const start = performance.now();
      const startFrames = live.frames;
      let cpuTime = 0;
      for (let i = 0; i < BATCH; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const usage = process.cpuUsage();
        live.render();
        const { user, system } = process.cpuUsage(usage);
        cpuTime += (user + system) / 1000;
      }
      await sync();
      total.push((performance.now() - start) / BATCH);
      cpu.push(cpuTime / BATCH);
      if (live.frames - startFrames < BATCH) throw new Error(`${name}: renderer did not advance every frame`);
    }
    results[name] = { totalMs: median(total), cpuMs: median(cpu) };
    live.dispose();
    console.log(
      `${job.renderer} | ${name}: ${results[name]!.totalMs.toFixed(2)} ms (cpu ${results[name]!.cpuMs.toFixed(2)} ms)`,
    );
  }
  await writeFile(job.out, `${JSON.stringify({ renderer: job.renderer, pass: job.pass, scenes: results }, null, 2)}\n`);
}

try {
  await main(JSON.parse(process.argv[2]!) as BenchJob);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
