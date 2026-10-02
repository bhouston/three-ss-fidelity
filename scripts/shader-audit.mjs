// Run after pnpm build: node scripts/shader-audit.mjs <output-dir> [renderer] [scene]
// Fresh process/device per sample; captures actual Dawn WGSL and synchronous API costs.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as headless from '../packages/cli/dist/headless/webgpu.js';
headless.install();
const salt = process.env.SHADER_AUDIT_SALT;
if (salt) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(salt)) throw new Error('Salt must be a WGSL identifier');
  const { create } = await import('../packages/cli/node_modules/webgpu/index.js');
  Object.defineProperty(navigator, 'gpu', {
    value: create(['enable-dawn-features=allow_unsafe_apis,disable_symbol_renaming,disable_blob_cache']),
    configurable: true,
  });
}
const out = process.argv[2];
if (!out) throw new Error('Output directory required');
await mkdir(out, { recursive: true });
const modules = [];
const pipelines = [];
const originalModule = GPUDevice.prototype.createShaderModule;
GPUDevice.prototype.createShaderModule = function (descriptor) {
  if (salt)
    descriptor = { ...descriptor, code: descriptor.code.replace(/\bnodeVar\d+\b/g, (name) => salt + '_' + name) };
  const start = performance.now();
  const result = originalModule.call(this, descriptor);
  modules.push({ code: descriptor.code, label: descriptor.label ?? '', ms: performance.now() - start });
  return result;
};
const originalPipeline = GPUDevice.prototype.createRenderPipeline;
GPUDevice.prototype.createRenderPipeline = function (descriptor) {
  const start = performance.now();
  const result = originalPipeline.call(this, descriptor);
  pipelines.push({ label: descriptor.label ?? '', ms: performance.now() - start });
  return result;
};
const { createRenderer, completeRenderer, createRendererFrameDriver } =
  await import('../packages/renderers/dist/index.js');
const { getScene, disposeSceneSetup } = await import('../packages/scenes/dist/index.js');
const { createNodeSceneContext } = await import('../packages/scenes/dist/node.js');
const { seededRandom } = await import('../packages/runtime/dist/index.js');
Math.random = seededRandom(1);
const name = process.argv[3] ?? 'three-new';
const scene = process.argv[4] ?? 'ssgi-basic';
const setup = await getScene(scene).create(createNodeSceneContext());
const resolutionScale = Number(process.env.SHADER_AUDIT_SCALE ?? 1);
if (!Number.isFinite(resolutionScale) || resolutionScale <= 0 || resolutionScale > 1)
  throw new Error('Scale must be in (0, 1]');
setup.effects.resolutionScale = resolutionScale;
const width = 256,
  height = 256;
const canvas = headless.createCanvas(width, height);
const start = performance.now();
const live = await createRenderer(name, canvas, setup, { width, height });
const initializedMs = performance.now() - start;
const advance = createRendererFrameDriver(live.renderer);
advance({ index: 0, timeSeconds: 0, deltaSeconds: 1 / 60, phase: 'warmup' });
live.render();
await completeRenderer(live.renderer);
const firstFrameMs = performance.now() - start;
const warmupFrames = Number(process.env.SHADER_AUDIT_WARMUP ?? 64);
const measureFrames = Number(process.env.SHADER_AUDIT_FRAMES ?? 100);
if (
  !Number.isSafeInteger(warmupFrames) ||
  warmupFrames < 4 ||
  !Number.isSafeInteger(measureFrames) ||
  measureFrames < 1
)
  throw new Error('Warmup must be at least four frames; measurement needs positive integral frames');
for (let i = 1; i < warmupFrames; i++) {
  advance({ index: i, timeSeconds: i / 60, deltaSeconds: 1 / 60, phase: 'warmup' });
  live.render();
  await completeRenderer(live.renderer);
}
const pixels = await headless.readPixels(canvas);
await writeFile(join(out, 'pixels.rgba'), pixels);
const runtimeStart = performance.now();
for (let i = warmupFrames; i < warmupFrames + measureFrames; i++) {
  advance({ index: i, timeSeconds: i / 60, deltaSeconds: 1 / 60, phase: 'measure' });
  live.render();
}
await completeRenderer(live.renderer);
const frameMs = (performance.now() - runtimeStart) / measureFrames;
const records = [];
for (const [i, module] of modules.entries()) {
  const file = `${String(i).padStart(3, '0')}.wgsl`;
  await writeFile(join(out, file), module.code);
  records.push({
    file,
    label: module.label,
    bytes: Buffer.byteLength(module.code),
    lines: module.code.split('\n').length,
    loops: (module.code.match(/\bfor\s*\(/g) ?? []).length,
    moduleMs: module.ms,
  });
}
const report = {
  name,
  scene,
  salt,
  width,
  height,
  resolutionScale,
  warmupFrames,
  measureFrames,
  initializedMs,
  firstFrameMs,
  frameMs,
  pixelHash: createHash('sha256').update(pixels).digest('hex'),
  adapter: Object.fromEntries(
    ['vendor', 'architecture', 'device', 'description'].map((key) => [
      key,
      live.renderer.backend.device.adapterInfo[key],
    ]),
  ),
  modules: records,
  pipelines,
};
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
live.dispose();
disposeSceneSetup(setup);
process.exit(0);
