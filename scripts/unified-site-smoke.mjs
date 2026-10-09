import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat, cp } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../submodules/fidelity-kit/packages/cli/package.json', import.meta.url));
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const work = await mkdtemp(join(tmpdir(), 'unified-kit-'));
const site = join(work, 'site');
const cli = resolve('submodules/fidelity-kit/packages/cli/dist/bin.js');
const smokeRenderer = process.env.SMOKE_RENDERER ?? 'three-current';
const liveFixture = process.env.SMOKE_LIVE_FIXTURE;
const uiOnly = process.env.SMOKE_UI_ONLY === 'true';
let cube;
const correctnessChromeArgs = [
  '--no-sandbox',
  '--enable-unsafe-webgpu',
  ...(uiOnly ? ['--disable-gpu', '--disable-webgl', '--disable-webgl2'] : []),
];
const execute = async (args) => {
  const browserArgs = ['render', 'benchmark'].includes(args[0])
    ? correctnessChromeArgs.map((flag) => `--chrome-arg=${flag}`)
    : [];
  return promisify(execFile)(
    process.execPath,
    [
      cli,
      ...args,
      ...browserArgs,
      ...(['render', 'benchmark'].includes(args[0]) && process.env.DISPLAY ? ['--headful'] : []),
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
};
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};
const servers = [];
async function serve(prefix) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (!path.startsWith(prefix)) throw new Error('Unknown prefix');
      let file = resolve(site, path.slice(prefix.length));
      if (!file.startsWith(site + sep) && file !== site) throw new Error('Invalid path');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}${prefix}`;
}
let browser;
try {
  const website = await serve('/project/');
  const renderer = await serve('/');
  if (uiOnly) {
    const { createUIFixtureServer } = await import('./ui-fixture-server.mjs');
    cube = await createUIFixtureServer();
  } else if (liveFixture === 'cube') {
    const { createCubeServer } = await import('../submodules/fidelity-kit/scripts/cube-server.mjs');
    cube = await createCubeServer();
  }
  await promisify(execFile)(
    process.execPath,
    ['scripts/build-site.mjs', '--out', site, '--root-url', renderer + 'render/'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  await promisify(execFile)(process.execPath, ['scripts/build-render-server.mjs', '--out', join(site, 'render')]);
  if (cube) {
    // Exercise full-HD UI/host contracts with a Canvas2D or hardware GPU fixture.
    // Project pathtracer capture and throughput checks below still use the actual render bundle.
    const manifestFile = join(site, 'data/site.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.rendererUrl = cube.url + 'index.html';
    await writeFile(manifestFile, JSON.stringify(manifest));
  }
  const chrome =
    process.env.CHROME_EXECUTABLE ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : puppeteer.executablePath());
  browser = await puppeteer.launch({
    headless: !process.env.DISPLAY,
    dumpio: process.env.CI === 'true',
    executablePath: chrome,
    args: correctnessChromeArgs,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(`Browser error: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`Browser console: ${message.text()}`);
  });
  async function waitForLive() {
    await page.waitForFunction(
      () => {
        const status = document.querySelector('output')?.textContent;
        return status && status !== 'Loading scene…';
      },
      { timeout: process.platform === 'linux' ? 300000 : 90000 },
    );
    assert.equal(await page.$eval('output', (element) => element.textContent), 'Running');
  }
  await page.goto(website, { waitUntil: 'networkidle0' });
  if (!uiOnly) {
    const hardware = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      const gpu = adapter
        ? ['vendor', 'architecture', 'device', 'description'].map((key) => adapter.info[key] ?? '').join(' ')
        : '';
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const extension = gl?.getExtension('WEBGL_debug_renderer_info');
      const webgl = gl ? gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) : '';
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return { gpu, webgl };
    });
    assert.ok(
      hardware.gpu &&
        hardware.webgl &&
        !/swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|\bwarp\b/i.test(
          hardware.gpu + ' ' + hardware.webgl,
        ),
      'Rendering verification blocked: real hardware WebGPU and WebGL are required. ' + JSON.stringify(hardware),
    );
    console.log('Hardware adapters:', hardware);
  }
  assert.equal(await page.$eval('h1', (element) => element.textContent), 'three-fidelity');
  assert.ok(await page.$eval('figure img', (image) => image.naturalWidth > 0));
  assert.equal(
    await page.$$eval('h2', (elements) => elements.map((e) => e.textContent).join(',')),
    'Fidelity,Performance,Live',
  );
  const hero = await page.$eval('figure a', (a) => a.href);
  await page.goto(hero, { waitUntil: 'networkidle0' });
  assert.ok(new URL(page.url()).searchParams.get('scene'));
  await page.goto(website + '?view=performance', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.performance-report .card');
  const detail = await page.$eval('.card-link', (a) => a.href);
  await page.goto(detail, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.performance-report .detail');
  assert.ok(new URL(page.url()).searchParams.get('result'));
  await page.goto(website + `?view=live&renderer=${smokeRenderer}&scene=cornell-box-basic`, {
    waitUntil: 'networkidle0',
  });
  console.log(
    `Checking live renderer: ${uiOnly ? 'Canvas2D UI contract fixture' : cube ? 'hardware WebGL cube fixture' : smokeRenderer}`,
  );
  await page.evaluate(() => {
    window.liveHarnessMessages = 0;
    window.addEventListener('message', (event) => {
      if (event.data?.protocol === 'performance-kit') window.liveHarnessMessages++;
    });
  });
  await page.click('button');
  await waitForLive();
  await page.waitForFunction(() => document.querySelector('[aria-label="Live frame rate"]')?.textContent !== '— FPS', {
    timeout: process.platform === 'linux' ? 180000 : 30000,
  });
  const original = await page.$eval('iframe', (frame) => frame.src);
  const renderFrame = page.frames().find((frame) => frame.url() === original);
  const checkLiveSize = async () => {
    const dimensions = await page.$eval('iframe', (frame) => [frame.clientWidth, frame.clientHeight]);
    await renderFrame.waitForFunction(
      (width, height) => {
        const canvas = document.querySelector('canvas');
        return canvas?.width === width && canvas?.height === height;
      },
      {},
      ...dimensions,
    );
    assert.ok(await page.$eval('iframe', (frame) => frame.getBoundingClientRect().right <= innerWidth));
  };
  await checkLiveSize();
  await page.setViewport({ width: 800, height: 700 });
  await checkLiveSize();
  await page.setViewport({ width: 1200, height: 900 });
  await checkLiveSize();
  console.log('Checking live canvas screenshot');
  const image = await (await renderFrame.$('canvas')).screenshot({ type: 'png' });
  assert.ok((await sharp(image).stats()).channels.some((channel) => channel.stdev > 10));
  await page.select('select[aria-label="Scene"]', 'cornell-box-basic-oblique');
  console.log('Checking live scene reset');
  assert.equal(await page.$eval('iframe', (frame) => frame.src), original);
  await page.click('button');
  assert.equal(await page.$eval('[aria-label="Live frame rate"]', (element) => element.textContent), '— FPS');
  assert.notEqual(await page.$eval('iframe', (frame) => frame.src), original);
  await waitForLive();
  assert.equal(await page.evaluate(() => window.liveHarnessMessages), 0);
  await page.goto(website, { waitUntil: 'networkidle0' });
  assert.deepEqual(errors, []);
  await browser.close();
  browser = undefined;
  if (!uiOnly) {
    // Exercise the actual CLI paths against the same separately hosted browser entry.
    console.log('Checking fidelity capture');
    const capture = join(work, 'fidelity');
    const captureRegistry = JSON.parse(await readFile('registry.json', 'utf8'));
    // A correctness capture needs two samples; the published reference target is 4096.
    const captureScene = captureRegistry.scenes.find((scene) => scene.id === 'cornell-box-basic');
    captureScene.fidelity.width = 320;
    captureScene.fidelity.height = 180;
    const captureRenderer = captureRegistry.renderers.find((renderer) => renderer.id === smokeRenderer);
    if (captureRenderer.params.samples) captureRenderer.params.samples = 2;
    const captureRegistryFile = join(work, 'capture-registry.json');
    await writeFile(captureRegistryFile, JSON.stringify(captureRegistry));
    await execute([
      'render',
      '--registry',
      captureRegistryFile,
      '--root-url',
      renderer + 'render/',
      '--out',
      capture,
      '--scene',
      'cornell-box-basic',
      '--renderer',
      smokeRenderer,
      '--frames',
      '2',
      '--executable-path',
      chrome,
    ]);
    assert.ok(
      (await sharp(join(capture, `cornell-box-basic/beauty/${smokeRenderer}.avif`)).stats()).channels.some(
        (channel) => channel.stdev > 10,
      ),
    );
    console.log('Checking combined render filters preserve existing captures without starting Chrome');
    const capturedFile = join(capture, `cornell-box-basic/beauty/${smokeRenderer}.avif`);
    const beforeSkip = await stat(capturedFile);
    const skipped = await execute([
      'render',
      '--registry',
      captureRegistryFile,
      '--out',
      capture,
      '--missing-only',
      '--scenes',
      'cornell-box-basi?',
      '--renderers',
      `?${smokeRenderer.slice(1)}`,
      '--executable-path',
      join(work, 'chrome-must-not-start'),
    ]);
    assert.ok(skipped.stdout.includes('skipped (image already exists)'));
    assert.equal((await stat(capturedFile)).mtimeMs, beforeSkip.mtimeMs);
    const suite = JSON.parse(await readFile('registry.json', 'utf8'));
    suite.performance = {
      default: {
        defaults: { capture: true, vsync: 'off', initTimeoutMs: process.platform === 'linux' ? 300000 : 60000 },
        entries: [
          {
            scene: 'cornell-box-basic',
            renderer: smokeRenderer,
            durationMs: 5000,
            params: { width: 320, height: 180 },
          },
        ],
      },
    };
    const suiteFile = join(work, 'registry.json');
    await writeFile(suiteFile, JSON.stringify(suite));
    const metrics = join(work, 'performance');
    console.log('Checking completed-frame benchmark');
    await execute([
      'benchmark',
      '--registry',
      suiteFile,
      '--root-url',
      renderer + 'render/',
      '--out',
      metrics,
      '--machine',
      'smoke',
      '--cooldown-ms',
      '0',
      '--fail-on-error=false',
      '--executable-path',
      chrome,
    ]);
    const history = JSON.parse(await readFile(join(metrics, 'index.json'), 'utf8'));
    const result = JSON.parse(await readFile(join(metrics, history.results[0].metrics), 'utf8'));
    // Only hardware adapters reach the completed-frame benchmark.
    assert.equal(result.status, 'ok', JSON.stringify(result.error ?? result));
    assert.ok(result.statistics.averageFps > 0);
    assert.ok(result.throughput.completedFrames > 0);
    assert.ok(result.throughput.elapsed >= 5);
    assert.equal(result.statistics.cpuSampleCount, 0);
    assert.equal(result.statistics.intervalCount, 0);
    console.log(
      'Passed: subpath home/hero, fidelity detail, performance detail, cross-origin live, responsive canvas, nonblack output, selection/reset, reporting disabled, shared browser render and benchmark CLIs.',
    );
  } else {
    console.log('Passed: grouped website, navigation, Canvas2D live lifecycle and responsive UI contracts.');
    console.warn(
      'Rendering verification blocked in hosted CI: no hardware GPU is provisioned. Hardware checks run separately; no software renderer was used.',
    );
  }
  if (process.env.SMOKE_ARTIFACTS) await cp(site, resolve(process.env.SMOKE_ARTIFACTS), { recursive: true });
} finally {
  await browser?.close();
  await cube?.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(work, { recursive: true, force: true });
}
