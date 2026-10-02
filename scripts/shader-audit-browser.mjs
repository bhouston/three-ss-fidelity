// Start the playground's Vite server first. Captures a fresh Chromium WebGPU session.
import { chromium } from '../packages/playground/node_modules/@playwright/test/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const out = process.argv[2];
if (!out) throw new Error('Output directory required');
await mkdir(out, { recursive: true });
const salt = process.env.SHADER_AUDIT_SALT;
if (salt && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(salt)) throw new Error('Salt must be a WGSL identifier');
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
    async ({ name, scene, root, salt: shaderSalt }) => {
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
      const live = await createRenderer(name, canvas, setup, { width: 256, height: 256 });
      const initializedMs = performance.now() - start;
      const advance = createRendererFrameDriver(live.renderer);
      advance({ index: 0, timeSeconds: 0, deltaSeconds: 1 / 60, phase: 'warmup' });
      live.render();
      await completeRenderer(live.renderer);
      const firstFrameMs = performance.now() - start;
      for (let i = 1; i < 16; i++) {
        advance({ index: i, timeSeconds: i / 60, deltaSeconds: 1 / 60, phase: 'warmup' });
        live.render();
        await completeRenderer(live.renderer);
      }
      const runtimeStart = performance.now();
      for (let i = 16; i < 36; i++) {
        advance({ index: i, timeSeconds: i / 60, deltaSeconds: 1 / 60, phase: 'measure' });
        live.render();
      }
      await completeRenderer(live.renderer);
      const frameMs = (performance.now() - runtimeStart) / 20;
      const adapter = Object.fromEntries(
        ['vendor', 'architecture', 'device', 'description'].map((key) => [
          key,
          live.renderer.backend.device.adapterInfo[key],
        ]),
      );
      live.dispose();
      return { name, scene, salt: shaderSalt, initializedMs, firstFrameMs, frameMs, adapter, modules, pipelines };
    },
    {
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
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
