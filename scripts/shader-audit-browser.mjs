// Start the playground's Vite server first. Captures a fresh Chromium WebGPU session.
import { chromium } from '../packages/playground/node_modules/@playwright/test/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
if (process.env.SHADER_AUDIT_PROFILE === '1' && (process.argv[3] ?? 'three-new') !== 'three-new')
  throw new Error('Startup builder profiling currently supports three-new');
const out = process.argv[2];
if (!out) throw new Error('Output directory required');
await mkdir(out, { recursive: true });
const salt = process.env.SHADER_AUDIT_SALT;
if (salt && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(salt)) throw new Error('Salt must be a WGSL identifier');
const warmupFrames = Number(process.env.SHADER_AUDIT_WARMUP ?? 16);
const measureFrames = Number(process.env.SHADER_AUDIT_FRAMES ?? 20);
if (
  !Number.isSafeInteger(warmupFrames) ||
  warmupFrames < 4 ||
  !Number.isSafeInteger(measureFrames) ||
  measureFrames < 1
)
  throw new Error('Warmup must be at least four frames; measurement needs positive integral frames');
const browser = await chromium.launch({
  headless: process.env.SHADER_AUDIT_HEADED !== '1',
  args: [
    '--enable-unsafe-webgpu',
    ...(salt ? ['--enable-dawn-features=disable_symbol_renaming,disable_blob_cache'] : []),
  ],
});
try {
  const page = await browser.newPage();
  page.on('console', (message) => console.error(message.text()));
  page.on('pageerror', (error) => console.error(error));
  await page.route('**/shader-audit.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto((process.env.SHADER_AUDIT_URL ?? 'http://127.0.0.1:5174') + '/shader-audit.html');
  const report = await page.evaluate(
    async ({ name, scene, root, salt: shaderSalt, profiling, warmupFrames: warmup, measureFrames: measured }) => {
      const profile = profiling
        ? (await import('/@fs' + root + '/scripts/shader-startup-profiler.mjs')).installShaderStartupProfiler({
            RendererClass: (await import('/@fs' + root + '/submodules/three.js/build/three.webgpu.js')).Renderer,
          })
        : null;
      const modules = [],
        pipelines = [];
      const originalModule = GPUDevice.prototype.createShaderModule;
      GPUDevice.prototype.createShaderModule = function (descriptor) {
        if (shaderSalt)
          descriptor = {
            ...descriptor,
            code: descriptor.code.replace(/\bnodeVar\d+\b/g, (identifier) => shaderSalt + '_' + identifier),
          };
        const start = performance.now();
        const result = originalModule.call(this, descriptor);
        modules.push({ label: descriptor.label, code: descriptor.code, ms: performance.now() - start });
        return result;
      };
      const originalPipeline = GPUDevice.prototype.createRenderPipeline;
      GPUDevice.prototype.createRenderPipeline = function (descriptor) {
        const start = performance.now();
        const result = originalPipeline.call(this, descriptor);
        pipelines.push({ label: descriptor.label, ms: performance.now() - start });
        return result;
      };
      const { createRenderer, completeRenderer, createRendererFrameDriver } = await import(
        '/@fs' + root + '/packages/renderers/src/index.ts'
      );
      const { getScene, createBrowserSceneContext } = await import('/@fs' + root + '/packages/scenes/src/index.ts');
      const { seededRandom } = await import('/@fs' + root + '/packages/runtime/src/index.ts');
      Math.random = seededRandom(1);
      const setup = await getScene(scene).create(createBrowserSceneContext('/'));
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      document.body.append(canvas);
      const start = performance.now();
      profile?.setPhase('factory');
      const factory = () => createRenderer(name, canvas, setup, { width: 256, height: 256 });
      const live = await (profile ? profile.measure('factory', factory) : factory());
      const initializedMs = performance.now() - start;
      const advance = createRendererFrameDriver(live.renderer);
      profile?.setPhase('first-frame');
      advance({ index: 0, timeSeconds: 0, deltaSeconds: 1 / 60, phase: 'warmup' });
      if (profile) profile.measure('first-render', () => live.render());
      else live.render();
      await (profile
        ? profile.measure('first-completion', () => completeRenderer(live.renderer))
        : completeRenderer(live.renderer));
      const firstFrameMs = performance.now() - start;
      profile?.setPhase('warmup');
      for (let i = 1; i < warmup; i++) {
        advance({ index: i, timeSeconds: i / 60, deltaSeconds: 1 / 60, phase: 'warmup' });
        live.render();
        await completeRenderer(live.renderer);
      }
      profile?.setPhase('measure');
      const runtimeStart = performance.now();
      for (let i = warmup; i < warmup + measured; i++) {
        advance({ index: i, timeSeconds: i / 60, deltaSeconds: 1 / 60, phase: 'measure' });
        live.render();
      }
      await completeRenderer(live.renderer);
      const frameMs = (performance.now() - runtimeStart) / measured;
      const adapter = Object.fromEntries(
        ['vendor', 'architecture', 'device', 'description'].map((key) => [
          key,
          live.renderer.backend.device.adapterInfo[key],
        ]),
      );
      let startup, trace;
      if (profile) {
        await profile.settled();
        startup = await profile.reportAsync({ includeSource: true });
        if (!startup.builders.length) throw new Error('No builder hooks captured: check Three.js module identity');
        trace = profile.trace();
        profile.restore();
      }
      live.dispose();
      return {
        name,
        scene,
        warmupFrames: warmup,
        measureFrames: measured,
        salt: shaderSalt,
        initializedMs,
        firstFrameMs,
        frameMs,
        adapter,
        modules,
        pipelines,
        startup,
        trace,
      };
    },
    {
      warmupFrames,
      measureFrames,
      profiling: process.env.SHADER_AUDIT_PROFILE === '1',
      salt,
      root: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
      name: process.argv[3] ?? 'three-new',
      scene: process.argv[4] ?? 'ssgi-basic',
    },
  );
  for (const [i, module] of report.modules.entries()) {
    const file = `${String(i).padStart(3, '0')}.wgsl`;
    await writeFile(join(out, file), module.code);
    module.file = file;
    module.bytes = Buffer.byteLength(module.code);
    module.lines = module.code.split('\n').length;
    module.loops = (module.code.match(/\bfor\s*\(/g) ?? []).length;
    delete module.code;
  }
  if (report.startup) {
    for (const source of report.startup.sources) {
      source.file = source.id + '.wgsl';
      await writeFile(join(out, source.file), source.code);
      delete source.code;
    }
    await writeFile(join(out, 'startup.json'), JSON.stringify(report.startup, null, 2) + '\n');
    await writeFile(join(out, 'startup-trace.json'), JSON.stringify(report.trace) + '\n');
    delete report.startup;
    delete report.trace;
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
