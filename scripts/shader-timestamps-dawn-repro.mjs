// Manual native Dawn timestamp repro; no Three.js query-pool code.
// Run: node scripts/shader-timestamps-dawn-repro.mjs [repository-root]
// RAW_TIMESTAMP_HEAVY=0 selects three cheap triangle passes.
// RAW_TIMESTAMP_FLAGS overrides the default Dawn flags as one option string.
// RAW_TIMESTAMP_OUT optionally also saves the JSON report.
// Apple M3 / Metal / macOS 27.0.1 / webgpu 0.6.1 produced overlapping
// intervals and large reported durations even for cheap passes. Supported
// timestamp queries do not establish reliable per-pass attribution here.
// Upstream Dawn samples render spans from vertex-stage start to fragment-stage
// end, which can overlap on a tiled GPU:
// https://github.com/google/dawn/blob/main/src/dawn/native/metal/CommandBufferMTL.mm
// The repro establishes an anomaly outside Three.js, not its underlying cause.
// Wall time includes query resolve/readback for timestamp cases and waits for
// queue completion without readback for the no-timestamps case.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const root = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url));
const { create, globals } = await import(`${root}/packages/cli/node_modules/webgpu/index.js`);
Object.assign(globalThis, globals);
const flags =
  process.env.RAW_TIMESTAMP_FLAGS ?? 'enable-dawn-features=allow_unsafe_apis,disable_timestamp_quantization';
const gpu = create([flags]);
const adapter = await gpu.requestAdapter();
if (!adapter?.features.has('timestamp-query')) throw new Error('timestamp-query unsupported');
const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
device.addEventListener('uncapturederror', (event) => {
  console.error(event.error);
});
const code = `
@vertex fn vertexMain(@builtin(vertex_index) index : u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
  return vec4f(positions[index],0.,1.);
}
@fragment fn cheap() -> @location(0) vec4f { return vec4f(0.2,0.3,0.4,1.); }
@fragment fn expensive(@builtin(position) p : vec4f) -> @location(0) vec4f {
  var h = u32(p.x)+u32(p.y)*1024u;
  for(var i = 0u; i < 4000u; i++) {
    h = (h ^ (h >> 16u)) * 747796405u + 2891336453u;
  }
  return vec4f(f32(h & 255u)/255.,f32((h >> 8u)&255u)/255.,0.,1.);
}`;
const module = device.createShaderModule({ code });
const makePipeline = (entryPoint) =>
  device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertexMain' },
    fragment: { module, entryPoint, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
const cheap = makePipeline('cheap');
const expensive = makePipeline('expensive');
const texture = device.createTexture({
  size: [128, 128],
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const view = texture.createView();
const queries = device.createQuerySet({ type: 'timestamp', count: 6 });
const resolve = device.createBuffer({ size: 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
const read = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

function addPass(encoder, index, pipeline, enableTimestamps = true) {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    ...(enableTimestamps
      ? {
          timestampWrites: {
            querySet: queries,
            beginningOfPassWriteIndex: index * 2,
            endOfPassWriteIndex: index * 2 + 1,
          },
        }
      : {}),
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
}
async function sample(mode) {
  const before = performance.now();
  const pipelines = process.env.RAW_TIMESTAMP_HEAVY === '0' ? [cheap, cheap, cheap] : [cheap, expensive, cheap];
  if (mode === 'no-timestamps') {
    const encoder = device.createCommandEncoder();
    pipelines.forEach((pipeline, index) => addPass(encoder, index, pipeline, false));
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return { mode, wallMs: performance.now() - before };
  }
  if (mode === 'one-command-buffer') {
    const encoder = device.createCommandEncoder();
    pipelines.forEach((pipeline, index) => addPass(encoder, index, pipeline));
    device.queue.submit([encoder.finish()]);
  } else {
    for (const [index, pipeline] of pipelines.entries()) {
      const encoder = device.createCommandEncoder();
      addPass(encoder, index, pipeline);
      device.queue.submit([encoder.finish()]);
      if (mode === 'one-submit-and-wait-per-pass') await device.queue.onSubmittedWorkDone();
    }
  }
  const encoder = device.createCommandEncoder();
  encoder.resolveQuerySet(queries, 0, 6, resolve, 0);
  encoder.copyBufferToBuffer(resolve, 0, read, 0, 48);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const wallMs = performance.now() - before;
  const times = [...new BigUint64Array(read.getMappedRange(), 0, 6)];
  read.unmap();
  const origin = times[0];
  const rows = pipelines.map((_, index) => ({
    pass: (process.env.RAW_TIMESTAMP_HEAVY === '0'
      ? ['cheap-0', 'cheap-1', 'cheap-2']
      : ['cheap-before', 'expensive', 'cheap-after'])[index],
    startNs: times[index * 2].toString(),
    endNs: times[index * 2 + 1].toString(),
    startMs: Number(times[index * 2] - origin) / 1e6,
    endMs: Number(times[index * 2 + 1] - origin) / 1e6,
    durationMs: Number(times[index * 2 + 1] - times[index * 2]) / 1e6,
  }));
  return {
    mode,
    wallMs,
    totalTimestampMs: Number(times[5] - origin) / 1e6,
    sumPassMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    rows,
  };
}
const report = {
  flags,
  heavyPass: process.env.RAW_TIMESTAMP_HEAVY !== '0',
  adapter: {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  },
  samples: [],
};
for (let repeat = 0; repeat < 3; repeat++) {
  for (const mode of ['no-timestamps', 'one-command-buffer', 'one-submit-per-pass', 'one-submit-and-wait-per-pass']) {
    report.samples.push({ repeat, ...(await sample(mode)) });
  }
}
console.log(JSON.stringify(report, null, 2));
if (process.env.RAW_TIMESTAMP_OUT)
  await writeFile(process.env.RAW_TIMESTAMP_OUT, JSON.stringify(report, null, 2) + '\n');
queries.destroy();
resolve.destroy();
read.destroy();
texture.destroy();
device.destroy();
