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
let cube;
const correctnessChromeArgs = [
  '--no-sandbox',
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  // Full-HD pathtracing can exceed Chrome's watchdog on the software CI adapter.
  ...(process.platform === 'linux'
    ? ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--disable-gpu-watchdog']
    : []),
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
  if (liveFixture === 'cube') {
    const { createCubeServer } = await import('../submodules/fidelity-kit/scripts/cube-server.mjs');
    cube = await createCubeServer();
  }
  await execute([
    'build',
    'fidelity-results',
    '--registry',
    'registry.json',
    '--performance-root',
    'performance-results',
    '--out',
    site,
    '--root-url',
    renderer + 'render/',
  ]);
  await promisify(execFile)(process.execPath, ['scripts/build-render-server.mjs', '--out', join(site, 'render')]);
  if (cube) {
    // Exercise full-HD UI/host contracts with a lightweight real GPU fixture on software CI.
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
  assert.equal(await page.$eval('h1', (element) => element.textContent), 'three-ss-fidelity');
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
  console.log(`Checking live renderer: ${cube ? 'WebGL cube contract fixture' : smokeRenderer}`);
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
  assert.deepEqual(await renderFrame.$eval('canvas', (canvas) => [canvas.width, canvas.height]), [1920, 1080]);
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
  const suite = JSON.parse(await readFile('registry.json', 'utf8'));
  suite.performance = {
    default: {
      defaults: { capture: true, vsync: 'off' },
      entries: [
        { scene: 'cornell-box-basic', renderer: smokeRenderer, durationMs: 5000, params: { width: 320, height: 180 } },
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
    '--allow-software',
    '--executable-path',
    chrome,
  ]);
  const result = JSON.parse(
    await readFile(join(metrics, `smoke/${smokeRenderer}/cornell-box-basic/metrics.json`), 'utf8'),
  );
  // CI may use a software adapter; this verifies contracts, not comparative hardware performance.
  assert.equal(result.status, 'ok');
  assert.ok(result.statistics.averageFps > 0);
  assert.ok(result.throughput.completedFrames > 0);
  assert.ok(result.throughput.elapsed >= 5);
  assert.equal(result.statistics.cpuSampleCount, 0);
  assert.equal(result.statistics.intervalCount, 0);
  console.log(
    'Passed: subpath home/hero, fidelity detail, performance detail, cross-origin live, fixed canvas, nonblack output, selection/reset, reporting disabled, shared browser render and benchmark CLIs.',
  );
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
