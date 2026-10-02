// Manual native Dawn baseline; no Three.js or TSL graph work.
// Run: node scripts/shader-startup-dawn-repro.mjs [repository-root]
// RAW_DAWN_OUT optionally also saves the JSON report.
// Cases distinguish repeated modules, new modules with identical WGSL, and new
// modules with unique helper/local names within this process. Flags disable
// Dawn blob caching and symbol renaming; OS/driver caching may still apply.
// The first pipeline includes one-time compiler/backend initialization.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const root = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url));
const { create, globals } = await import(`${root}/packages/cli/node_modules/webgpu/index.js`);
Object.assign(globalThis, globals);
const flags = 'enable-dawn-features=allow_unsafe_apis,disable_symbol_renaming,disable_blob_cache';
const gpu = create([flags]);
const adapter = await gpu.requestAdapter();
const device = await adapter.requestDevice();
const code = (salt) => `
fn ${salt}_color() -> vec4f { return vec4f(0.2,0.3,0.4,1.); }
@vertex fn vertexMain(@builtin(vertex_index) index : u32) -> @builtin(position) vec4f {
  let ${salt}_positions = array<vec2f, 3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
  return vec4f(${salt}_positions[index],0.,1.);
}
@fragment fn fragmentMain() -> @location(0) vec4f { return ${salt}_color(); }
`;
const samples = [];
const source = code('stable');
let sharedModule;
for (let index = 0; index < 5; index++) {
  for (const mode of ['same-module', 'same-source-new-module', 'unique-source-new-module']) {
    const shader = mode === 'unique-source-new-module' ? code(`unique_${index}`) : source;
    const begin = performance.now();
    const module = mode === 'same-module' && sharedModule ? sharedModule : device.createShaderModule({ code: shader });
    const moduleMs = performance.now() - begin;
    if (mode === 'same-module') sharedModule = module;
    const descriptor = {
      layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    };
    const pipelineStart = performance.now();
    const pipeline = device.createRenderPipeline(descriptor);
    const pipelineMs = performance.now() - pipelineStart;
    samples.push({ index, mode, bytes: Buffer.byteLength(shader), moduleMs, pipelineMs });
    if (!pipeline) throw new Error('Missing pipeline');
  }
}
const report = {
  flags,
  adapter: {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  },
  samples,
};
console.log(JSON.stringify(report, null, 2));
if (process.env.RAW_DAWN_OUT) await writeFile(process.env.RAW_DAWN_OUT, JSON.stringify(report, null, 2) + '\n');
device.destroy();
