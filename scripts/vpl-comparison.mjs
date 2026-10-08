// Browser comparison: fresh browser per scene/repetition, GPU completion at batch boundaries.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/playground/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const [stage, scene, repetition = '1', renderer = 'three-new-vpl-shadow-maps'] = process.argv.slice(2);
const out = join('docs/history/vpl-multiple-bounces', stage, scene);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
try {
  const page = await browser.newPage({ viewport: { width: 680, height: 520 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.route('**/comparison.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>' }),
  );
  await page.goto('http://127.0.0.1:5173/comparison.html');
  const result = await page.evaluate(
    async ({ scene: sceneName, renderer: rendererName }) => {
      const { createPerformanceSession } = await import('/src/performance-session.ts');
      const environment = {};
      const reporter = {
        phaseStart() {},
        phaseEnd() {},
        environment(value) {
          Object.assign(environment, value);
        },
        frameBegin() {},
        frameEnd() {},
        async convergence() {},
        ready() {},
      };
      const start = performance.now();
      const session = await createPerformanceSession(
        { scene: sceneName, renderer: rendererName, width: 640, height: 480, seed: 1 },
        reporter,
        document.body,
      );
      const setupMs = performance.now() - start;
      const cold = performance.now();
      for (let i = 1; i < 192; i++) session.draw();
      await session.complete();
      const convergenceMs = performance.now() - cold;
      const batchesMs = [];
      for (let batch = 0; batch < 5; batch++) {
        const started = performance.now();
        for (let i = 0; i < 30; i++) session.draw();
        await session.complete();
        batchesMs.push((performance.now() - started) / 30);
      }
      window.comparisonSession = session;
      return {
        setupMs,
        convergenceMs,
        batchesMs,
        medianFrameMs: batchesMs.toSorted((a, b) => a - b)[2],
        environment,
        accumulated: session.accumulated(),
        lighting: session.lighting(),
      };
    },
    { scene, renderer },
  );
  await page.locator('canvas').screenshot({ path: join(out, `capture-${repetition}.png`) });
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(
    join(out, `timing-${repetition}.json`),
    JSON.stringify(
      {
        stage,
        scene,
        renderer,
        repetition: Number(repetition),
        browserVersion: browser.version(),
        runtime: process.version,
        width: 640,
        height: 480,
        warmupFrames: 192,
        batchFrames: 30,
        ...result,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ stage, scene, repetition, ...result }));
} finally {
  await browser.close();
}
