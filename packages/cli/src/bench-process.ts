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
  /**
   * Screen-space renderers only: create with `trackTimestamp: true` and report WebGPU timestamp-query GPU ms
   * (per frame, and per named render/compute pass) alongside wall-clock totalMs. Forces a per-frame GPU sync
   * (resolveTimestampsAsync), so totalMs in this mode measures sync-per-frame latency, not pipelined throughput.
   */
  gpu: boolean;
}

export interface PassTiming {
  name: string;
  ms: number;
}

export interface SceneBenchResult {
  /** Median ms/frame of a GPU-synced batch: steady-state wall time, not just CPU submit time. */
  totalMs: number;
  /** Median ms/frame of CPU time spent inside render() (robust to OS scheduling contention). */
  cpuMs: number;
  /** --gpu only: median ms/frame summed across every render + compute timestamp range recorded that frame. */
  gpuMs?: number;
  /** --gpu only: median ms per named render/compute pass, descending. Falls back to a uid when unnamed. */
  passes?: PassTiming[];
}

const BATCH = 20;
const median = (values: number[]): number => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** Timestamp-query internals three's public API/types don't expose (see TimestampQueryPool.js, WebGPUBackend.js). */
interface TimestampBackend {
  device: GPUDevice;
  updateTimeStampUID(context: unknown): void;
  getTimestampUID(context: unknown): string;
  timestampQueryPool: Record<'render' | 'compute', { timestamps: Map<string, number> } | null>;
}
interface TimestampRenderer {
  backend: TimestampBackend;
  render(scene: unknown, camera: unknown): void;
  compute(computeNodes: unknown, dispatchSize?: unknown): unknown;
  hasFeature(name: string): boolean;
  resolveTimestampsAsync(type: 'render' | 'compute'): Promise<number | undefined>;
}

/** A render/compute context's timestamp uid is `<prefix>:<frameCalls>:<id>:f<frame>` (Backend.updateTimeStampUID);
 * stripping the frame suffix gives a key that is stable across frames for the same pass, in steady state. */
const stripFrame = (uid: string): string => uid.replace(/:f\d+$/, '');

/**
 * Monkey-patches this renderer instance (not the three.js/renderers package) to record, per timestamp uid, the
 * name of the scene/QuadMesh/compute node it was rendering for -- e.g. QuadMesh.name ('SSR [ Reflections ]') or
 * Mesh.name ('Pre-Pass'). RenderContext itself carries no such label, so this is the only attribution available
 * without editing three.js: it's inferred from the `scene` argument passed into the wrapped render()/compute().
 */
function attachPassNaming(renderer: TimestampRenderer): Map<string, string> {
  const namesByKey = new Map<string, string>();
  let currentName = '';

  const { backend } = renderer;
  const originalUpdate = backend.updateTimeStampUID.bind(backend);
  backend.updateTimeStampUID = (context: unknown) => {
    originalUpdate(context);
    if (currentName) namesByKey.set(stripFrame(backend.getTimestampUID(context)), currentName);
  };

  const originalRender = renderer.render.bind(renderer);
  renderer.render = (scene: unknown, camera: unknown) => {
    const previous = currentName;
    currentName = (scene as { name?: string } | null)?.name || '';
    try {
      originalRender(scene, camera);
    } finally {
      currentName = previous;
    }
  };

  const originalCompute = renderer.compute.bind(renderer);
  renderer.compute = (computeNodes: unknown, dispatchSize?: unknown) => {
    const previous = currentName;
    const nodes = Array.isArray(computeNodes) ? computeNodes : [computeNodes];
    currentName =
      nodes
        .map((node) => (node as { name?: string } | null)?.name)
        .filter((name): name is string => !!name)
        .join(', ') || 'compute';
    try {
      return originalCompute(computeNodes, dispatchSize);
    } finally {
      currentName = previous;
    }
  };

  return namesByKey;
}

async function main(job: BenchJob): Promise<void> {
  const screenSpace = job.renderer !== 'three-gpu-pathtracer';
  const headless = screenSpace ? await import('./headless/webgpu.js') : await import('./headless/webgl.js');
  headless.install();
  const { createRenderer } = await import('@ss-fidelity/renderers');
  const { getScene } = await import('@ss-fidelity/scenes');
  const { createNodeSceneContext } = await import('@ss-fidelity/scenes/node');
  const ctx = createNodeSceneContext();
  const results: Record<string, SceneBenchResult> = {};
  let warnedUnsupported = false;

  for (const name of job.scenes) {
    const setup = await getScene(name).create(ctx);
    const canvas = headless.createCanvas(job.width, job.height);
    const trackTimestamp = job.gpu && screenSpace;
    const live = await createRenderer(job.renderer, canvas, setup, {
      width: job.width,
      height: job.height,
      pass: job.pass,
      trackTimestamp,
    });
    await headless.ready();
    const gpuRenderer = live.renderer as unknown as TimestampRenderer;
    const gpuSupported = trackTimestamp && gpuRenderer.hasFeature('timestamp-query');
    if (trackTimestamp && !gpuSupported && !warnedUnsupported) {
      console.error(`${job.renderer}: adapter has no "timestamp-query" feature; --gpu timing unavailable`);
      warnedUnsupported = true;
    }
    const passNamesByKey = gpuSupported ? attachPassNaming(gpuRenderer) : undefined;

    // GPU queue sync: dawn (WebGPU) exposes the actual submitted work; the WebGL (ANGLE) backend used for
    // three-gpu-pathtracer has no such API here, so a pixel readback (already synchronous) stands in for it.
    // In --gpu mode, resolving the timestamp queries every frame already forces the same GPU completion.
    const sync = screenSpace
      ? () =>
          (live.renderer as unknown as { backend: { device: GPUDevice } }).backend.device.queue.onSubmittedWorkDone()
      : () => headless.readPixels(canvas);

    for (let i = 0; i < job.warmup; i++) {
      headless.animationFrame();
      live.render();
      await sync();
      await new Promise((resolve) => setImmediate(resolve)); // async shader compilation
    }
    // Warmup's timestamp queries were never resolved (only the measured loop below resolves them); drain that
    // backlog now so the first measured frame's samples aren't inflated by every unresolved warmup frame's passes.
    if (gpuSupported) {
      await gpuRenderer.resolveTimestampsAsync('render');
      await gpuRenderer.resolveTimestampsAsync('compute');
    }

    // The node frame (and with it every effect pass) only advances in the renderer's animation loop, which
    // headless.animationFrame() runs: without it, back-to-back render() calls would re-run only the final output
    // pass. See live.frames check below.
    const cpu: number[] = [];
    const total: number[] = [];
    const gpuTotals: number[] = [];
    const passSamples = new Map<string, number[]>();
    for (let batch = 0; batch < Math.ceil(job.measure / BATCH); batch++) {
      const start = performance.now();
      const startFrames = live.frames;
      let cpuTime = 0;
      for (let i = 0; i < BATCH; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        headless.animationFrame();
        const usage = process.cpuUsage();
        live.render();
        const { user, system } = process.cpuUsage(usage);
        cpuTime += (user + system) / 1000;
        if (gpuSupported) {
          await gpuRenderer.resolveTimestampsAsync('render');
          await gpuRenderer.resolveTimestampsAsync('compute');
          let frameTotal = 0;
          for (const type of ['render', 'compute'] as const) {
            const pool = gpuRenderer.backend.timestampQueryPool[type];
            if (!pool) continue;
            for (const [uid, duration] of pool.timestamps) {
              frameTotal += duration;
              const passName = passNamesByKey?.get(stripFrame(uid)) ?? stripFrame(uid);
              const samples = passSamples.get(passName);
              if (samples) samples.push(duration);
              else passSamples.set(passName, [duration]);
            }
          }
          gpuTotals.push(frameTotal);
        }
      }
      // Already GPU-synced above every frame when tracking timestamps; avoid syncing twice.
      if (!gpuSupported) await sync();
      total.push((performance.now() - start) / BATCH);
      cpu.push(cpuTime / BATCH);
      if (live.frames - startFrames < BATCH) throw new Error(`${name}: renderer did not advance every frame`);
    }
    const result: SceneBenchResult = { totalMs: median(total), cpuMs: median(cpu) };
    if (gpuSupported) {
      result.gpuMs = median(gpuTotals);
      result.passes = [...passSamples.entries()]
        .map(([passName, samples]) => ({ name: passName, ms: median(samples) }))
        .toSorted((a, b) => b.ms - a.ms);
    }
    results[name] = result;
    live.dispose();
    console.log(
      `${job.renderer} | ${name}: ${result.totalMs.toFixed(2)} ms (cpu ${result.cpuMs.toFixed(2)} ms)` +
        (trackTimestamp && !gpuSupported ? ' (gpu unsupported)' : ''),
    );
    if (result.gpuMs !== undefined) {
      console.log(`  gpu ${result.gpuMs.toFixed(3)} ms/frame`);
      for (const pass of result.passes ?? []) console.log(`    ${pass.name}: ${pass.ms.toFixed(3)} ms`);
    }
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
