// Frame-time benchmark of the three-ss pipeline (headless dawn).
// Medians over batches of back-to-back frames (see below); --measure frames in total.
// Usage: node packages/cli/perf/bench.mjs [--pass beauty] [--width 1920 --height 1080] [--scenes a,b] [--out file.json]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as headless from '../dist/headless/webgpu.js';

const { values: args } = parseArgs({
  options: {
    pass: { type: 'string', default: 'beauty' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
    scenes: { type: 'string' },
    warmup: { type: 'string', default: '60' },
    measure: { type: 'string', default: '120' },
    out: { type: 'string' },
  },
});
headless.install();
const { createRenderer } = await import('@ss-fidelity/renderers');
const { getScene, listSceneNames } = await import('@ss-fidelity/scenes');
const { createNodeSceneContext } = await import('@ss-fidelity/scenes/node');

const width = Number(args.width);
const height = Number(args.height);
const warmup = Number(args.warmup);
const measure = Number(args.measure);
const BATCH = 20;
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const ctx = createNodeSceneContext();
const results = {};

for (const name of args.scenes ? args.scenes.split(',') : listSceneNames()) {
  const setup = await getScene(name).create(ctx);
  const canvas = headless.createCanvas(width, height);
  const live = await createRenderer('three-ss', canvas, setup, { width, height, pass: args.pass });
  await headless.ready();
  const device = live.renderer.backend.device;
  for (let i = 0; i < warmup; i++) {
    live.render();
    await device.queue.onSubmittedWorkDone();
    await new Promise((resolve) => setImmediate(resolve)); // async shader compilation
  }
  // Throughput: batches of frames submitted without waiting on the GPU keep it saturated (steady clocks); total =
  // batch wall time per frame, cpu = process CPU time of the render() calls per frame (robust to scheduling
  // contention). The node frame (and with it every effect pass) only advances in the renderer's animation loop,
  // which the headless requestAnimationFrame runs from a timer, so each frame must yield to it: back-to-back
  // render() calls would re-run only the final output pass.
  const nodeFrame = live.renderer._nodes.nodeFrame;
  const cpu = [];
  const total = [];
  for (let batch = 0; batch < measure / BATCH; batch++) {
    const start = performance.now();
    const firstFrame = nodeFrame.frameId;
    let cpuTime = 0;
    for (let i = 0; i < BATCH; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const usage = process.cpuUsage();
      live.render();
      const { user, system } = process.cpuUsage(usage);
      cpuTime += (user + system) / 1000;
    }
    await device.queue.onSubmittedWorkDone();
    total.push((performance.now() - start) / BATCH);
    cpu.push(cpuTime / BATCH);
    if (nodeFrame.frameId - firstFrame < BATCH) throw new Error(`${name}: effects did not run every frame`);
  }
  results[name] = { cpu: median(cpu), total: median(total) };
  live.dispose();
  console.log(`${name}: ${results[name].total.toFixed(2)} ms (cpu ${results[name].cpu.toFixed(2)} ms)`);
}
const sum = (key) => Object.values(results).reduce((acc, r) => acc + r[key], 0);
const summary = { pass: args.pass, width, height, totalMs: sum('total'), cpuMs: sum('cpu'), scenes: results };
console.log(`overall: ${summary.totalMs.toFixed(2)} ms (cpu ${summary.cpuMs.toFixed(2)} ms)`);
if (args.out) writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
process.exit(0);
