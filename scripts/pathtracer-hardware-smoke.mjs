import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../submodules/fidelity-kit/packages/cli/package.json', import.meta.url));
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const root = resolve('packages/playground/dist');
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/probe.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<html></html>');
      return;
    }
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', extname(file) === '.html' ? 'text/html' : 'text/javascript');
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_EXECUTABLE ?? puppeteer.executablePath(),
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu'],
  });
  const probe = await browser.newPage();
  await probe.goto('http://127.0.0.1:' + server.address().port + '/probe.html');
  const hardware = await probe.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const gpu = adapter
      ? ['vendor', 'architecture', 'device', 'description'].map((key) => adapter.info[key] ?? '').join(' ')
      : '';
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const webgl = gl ? gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return { gpu, webgl };
  });
  assert.ok(
    hardware.gpu &&
      hardware.webgl &&
      !/swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|\bwarp\b/i.test(
        hardware.gpu + ' ' + hardware.webgl,
      ),
    'Rendering verification blocked: real hardware GPUs required. ' + JSON.stringify(hardware),
  );
  console.log('Hardware:', hardware);
  await probe.close();
  for (const renderer of ['three-gpu-pathtracer', 'three-gpu-pathtracer-webgpu-experimental']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 32, height: 32 });
    const url = new URL('http://127.0.0.1:' + server.address().port + '/performance.html');
    url.searchParams.set('fidelityKitMode', 'capture');
    url.searchParams.set(
      'fidelityKitParams',
      JSON.stringify({
        renderer,
        scene: 'cornell-box-basic',
        width: 32,
        height: 32,
        samples: 2,
        noiseThreshold: 0,
        minSamples: 2,
        seed: 1,
      }),
    );
    await page.goto(url.href);
    await page.waitForFunction(() => window.__fidelityKitCapture || window.__fidelityKitError, { timeout: 180000 });
    const status = await page.evaluate(() => ({
      capture: window.__fidelityKitCapture,
      error: window.__fidelityKitError,
    }));
    assert.equal(status.error, undefined);
    assert.equal(status.capture.samples, 2);
    const stats = await sharp(await (await page.$('canvas')).screenshot()).stats();
    assert.ok(
      stats.channels.slice(0, 3).some((channel) => channel.stdev > 10),
      'Empty or flat capture',
    );
    console.log(renderer + ': two GPU-completed samples, non-flat capture');
    await page.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
