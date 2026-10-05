#!/usr/bin/env node
// Reproduces Chrome WebGPU issues on Linux described in docs/performance/CHROME_LINUX_WEBGPU.md.
// Usage: node scripts/chrome-webgpu-linux-probe.mjs [adapter|backpressure|readback|all] [--chrome <path>]
// Uses the puppeteer installed for performance-kit and its bundled Chrome unless --chrome is given.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(new URL('../submodules/performance-kit/packages/cli/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer'));
const { default: sharp } = await import(require.resolve('sharp'));

// Errors below 3 (of 255) are rounding; anything larger means the pixels are wrong.
const verdict = (error) => (error < 3 ? 'correct' : 'CORRUPTED');

// Mean absolute error of the decoded PNG against the expected gradient, sampled every 10 pixels.
async function gradientError(png) {
  const { data, info } = await sharp(Buffer.from(png)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let error = 0;
  let samples = 0;
  for (let y = 5; y < info.height; y += 10)
    for (let x = 5; x < info.width; x += 10) {
      const i = (y * info.width + x) * 3;
      const expected = [((x + 0.5) / 960) * 255, ((y + 0.5) / 540) * 255, 0.25 * 255];
      for (let c = 0; c < 3; c++) error += Math.abs(data[i + c] - expected[c]);
      samples += 3;
    }
  return +(error / samples).toFixed(1);
}
const mode = process.argv[2] ?? 'all';
const chromeIndex = process.argv.indexOf('--chrome');
const executablePath = chromeIndex > 0 ? process.argv[chromeIndex + 1] : undefined;

const vulkan = ['--enable-features=Vulkan', '--use-angle=vulkan'];
const base = [
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];
const vsyncOff = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

// A full-screen fragment shader whose cost is set by `iterations`.
const page = (iterations) => `<!doctype html><body style="margin:0">
<canvas width=1920 height=1080 style="width:1920px;height:1080px"></canvas><script type=module>
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) { window.result = { error: 'requestAdapter() returned null' }; throw new Error('no adapter'); }
const device = await adapter.requestDevice();
const context = document.querySelector('canvas').getContext('webgpu');
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
const module = device.createShaderModule({ code: \`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  var c = 0.0;
  for (var k = 0; k < ${iterations}; k++) { c += sin(p.x * 0.01 + f32(k)) * cos(p.y * 0.01); }
  return vec4f(fract(c), 0.3, 0.5, 1);
}\` });
const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format }] } });
let frames = 0;
const start = performance.now();
async function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  frames++;
  if (performance.now() - start < 3000) { requestAnimationFrame(frame); return; }
  const rafFps = frames / ((performance.now() - start) / 1000);
  const drainStart = performance.now();
  await device.queue.onSubmittedWorkDone();
  const drainMs = performance.now() - drainStart;
  const blobStart = performance.now();
  const blob = await new Promise((resolve) => document.querySelector('canvas').toBlob(resolve, 'image/png'));
  window.result = { rafFps: +rafFps.toFixed(1), drainMs: Math.round(drainMs), toBlobMs: Math.round(performance.now() - blobStart), blobBytes: blob?.size ?? 0 };
}
requestAnimationFrame(frame);
</script>`;

// Renders a known gradient, reads it back with canvas.toBlob(), decodes the PNG and compares pixels.
const readbackPage = `<!doctype html><body style="margin:0"><canvas width=960 height=540 style="width:960px;height:540px"></canvas><script type=module>
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const canvas = document.querySelector('canvas');
const context = canvas.getContext('webgpu');
const format = navigator.gpu.getPreferredCanvasFormat();
// The same configuration three.js WebGPURenderer uses by default.
context.configure({ device, format, alphaMode: 'premultiplied', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, toneMapping: { mode: 'standard' } });
const module = device.createShaderModule({ code: \`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return vec4f(p.x / 960.0, p.y / 540.0, 0.25, 1.0); }\` });
const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format }] } });
const draw = () => {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
};
let frames = 0;
const loop = async () => {
  draw();
  if (++frames < 30) { requestAnimationFrame(loop); return; }
  await device.queue.onSubmittedWorkDone();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const bitmap = await createImageBitmap(blob);
  const check = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  check.drawImage(bitmap, 0, 0);
  const pixels = check.getImageData(0, 0, bitmap.width, bitmap.height).data;
  let error = 0;
  let samples = 0;
  for (let y = 5; y < 540; y += 10)
    for (let x = 5; x < 960; x += 10) {
      const i = (y * 960 + x) * 4;
      const expected = [((x + 0.5) / 960) * 255, ((y + 0.5) / 540) * 255, 0.25 * 255];
      for (let c = 0; c < 3; c++) error += Math.abs(pixels[i + c] - expected[c]);
      samples += 3;
    }
  const meanError = error / samples;
  window.result = { format, blobBytes: blob.size, inPageDecodeError: +meanError.toFixed(1), png: Array.from(new Uint8Array(await blob.arrayBuffer())) };
};
requestAnimationFrame(loop);
</script>`;

let iterations = 400;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(request.url === '/readback' ? readbackPage : page(iterations));
}).listen(4499);

async function launch(headless, args) {
  return puppeteer.launch({ headless, args, executablePath, defaultViewport: { width: 1920, height: 1080 } });
}

async function adapterProbe() {
  console.log('\n# Adapter selection (headless)');
  for (const [name, flags] of [
    ['default flags', []],
    ['Vulkan flags', vulkan],
  ]) {
    const browser = await launch(true, [...base, ...flags]);
    const tab = await browser.newPage();
    await tab.goto('http://localhost:4499/blank');
    const result = await tab.evaluate(async () => {
      const describe = (a) => (a ? `${a.info.vendor}/${a.info.architecture}/${a.info.description}` : null);
      const attempts = [];
      for (let i = 0; i < 3; i++) {
        attempts.push(describe(await navigator.gpu.requestAdapter()));
        await new Promise((r) => setTimeout(r, 100));
      }
      const gl = document.createElement('canvas').getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        requestAdapterAttempts: attempts,
        webgl2Renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      };
    });
    console.log(name, JSON.stringify(result));
    await browser.close();
  }
}

async function backpressureProbe() {
  console.log('\n# Frame backpressure: rAF rate vs. GPU work left queued after 3 s');
  const cases = [
    ['headful,  vsync on', false, []],
    ['headless, vsync on', true, []],
    ['headful,  --disable-gpu-vsync only', false, ['--disable-gpu-vsync']],
    ['headful,  vsync off (both flags)', false, vsyncOff],
    ['headless, vsync off (both flags)', true, vsyncOff],
  ];
  for (const [label, count] of [
    ['light shader (GPU > 60 fps)', 400],
    ['heavy shader (GPU < 60 fps)', 3000],
  ]) {
    iterations = count;
    console.log(`\n## ${label}`);
    for (const [name, headless, flags] of cases) {
      const browser = await launch(headless, [...base, ...vulkan, ...flags]);
      try {
        const tab = await browser.newPage();
        // Work around the first-request race (issue 2) before the measured page loads.
        await tab.goto('http://localhost:4499/blank');
        await tab.evaluate(async () => {
          for (let i = 0; i < 30 && !(await navigator.gpu.requestAdapter()); i++)
            await new Promise((r) => setTimeout(r, 100));
        });
        await tab.goto('http://localhost:4499/');
        const result = await tab
          .waitForFunction(() => window.result, { timeout: 60000, polling: 500 })
          .then(() => tab.evaluate(() => window.result))
          .catch((error) => `no result within 60 s (${error.message.slice(0, 60)})`);
        console.log(name.padEnd(40), JSON.stringify(result));
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }
}

async function readbackProbe() {
  console.log('\n# canvas.toBlob() readback of a WebGPU canvas (expected gradient vs. decoded PNG)');
  for (const [name, headless, flags] of [
    ['headful,  default flags', false, []],
    ['headful,  --use-angle=vulkan', false, ['--use-angle=vulkan']],
    ['headful,  --enable-features=Vulkan', false, ['--enable-features=Vulkan']],
    ['headful,  Vulkan flags', false, vulkan],
    ['headful,  Vulkan flags, --ozone-platform=x11', false, [...vulkan, '--ozone-platform=x11']],
    ['headless, Vulkan flags', true, vulkan],
  ]) {
    const browser = await launch(headless, [...base, ...flags]);
    try {
      const tab = await browser.newPage();
      await tab.goto('http://localhost:4499/blank');
      await tab.evaluate(async () => {
        for (let i = 0; i < 30 && !(await navigator.gpu.requestAdapter()); i++)
          await new Promise((r) => setTimeout(r, 100));
      });
      const errors = [];
      tab.on('pageerror', (error) => errors.push(String(error)));
      await tab.goto('http://localhost:4499/readback');
      const ready = await tab
        .waitForFunction(() => window.result, { timeout: 30000 })
        .then(
          () => true,
          () => false,
        );
      if (!ready) {
        console.log(name.padEnd(46), 'no result within 30 s', errors.slice(0, 2));
        continue;
      }
      const { png, ...result } = await tab.evaluate(() => window.result);
      const pngError = await gradientError(png);
      console.log(
        name.padEnd(46),
        JSON.stringify({
          ...result,
          pngError,
          toBlob: verdict(pngError),
          inPageDecode: verdict(result.inPageDecodeError),
        }),
      );
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

try {
  if (mode === 'adapter' || mode === 'all') await adapterProbe();
  if (mode === 'readback' || mode === 'all') await readbackProbe();
  if (mode === 'backpressure' || mode === 'all') await backpressureProbe();
} finally {
  server.close();
}
