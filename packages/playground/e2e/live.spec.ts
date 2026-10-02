import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

test('camera movement replaces history and settings support Back and Forward', async ({ page }) => {
  await page.goto('/?scene=ssgi-basic&renderer=three-new&width=160&height=120&repeats=2');
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  const initialLength = await page.evaluate(() => history.length);
  const initialCamera = new URL(page.url()).searchParams.get('camera');
  const box = (await page.locator('#viewport canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get('camera')).not.toBe(initialCamera);
  expect(await page.evaluate(() => history.length)).toBe(initialLength);

  // Save settings while damping may still have a trailing camera update pending.
  await page.locator('#repeats').fill('4');
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
  await expect.poll(() => new URL(page.url()).searchParams.get('repeats')).toBe('4');
  await page.goBack();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#repeats')).toHaveValue('2');
  await page.goForward();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#repeats')).toHaveValue('4');
});

test('live scene, GPU/CPU reports, image capture, saved-report import and cancellation', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?scene=ssgi-basic&renderer=three-new');
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await page.locator('#width').fill('160');
  await page.locator('#height').fill('120');
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive');
  await expect(page.locator('#gauge-p95')).toContainText('ms');
  await page.locator('#live-gpu').check();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#instrument-status')).toContainText(/GPU sampled|unsupported|does not expose/);
  if ((await page.locator('#instrument-status').textContent())?.includes('GPU sampled')) {
    await expect(page.locator('#live-passes tr').first()).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('initial-live.png'), fullPage: true });
  const canvas = page.locator('#viewport canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get('camera')).not.toBeNull();
  await page.locator('#duration').fill('0.1');
  await page.locator('#repeats').fill('1');
  await page.locator('#warmup').fill('2');
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Report ready', { timeout: 90000 });
  const frame = page.frameLocator('#report');
  await expect(frame.getByRole('heading', { name: 'Rendering performance' })).toBeVisible({ timeout: 30000 });
  await expect(frame.locator('#runs tr')).toHaveCount(1);
  await expect(frame.locator('#chart path')).toHaveCount(1);
  const reportWidth = await page.locator('#report').evaluate((node) => node.getBoundingClientRect().width);
  expect(reportWidth).toBeGreaterThan(800);
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download report JSON', exact: true }).click();
  const download = await saved;
  const file = (await download.path())!;
  const report = JSON.parse(await readFile(file, 'utf8'));
  expect(report.schemaVersion).toBe(1);
  expect(
    report.entries[0].runs[0].metrics.some(
      (metric: { descriptor: { id: string } }) => metric.descriptor.id === 'cadence.frame',
    ),
  ).toBe(true);
  await page.locator('#report-file').setInputFiles(file);
  await expect(frame.locator('#runs tr')).toHaveCount(1);

  await page.locator('#protocol').selectOption('throughput');
  await page.locator('#compare').check();
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Report ready', { timeout: 90000 });
  await expect(frame.locator('#runs tr')).toHaveCount(2);
  await expect(page.locator('#message')).toContainText('speedup');

  await page.locator('#compare').uncheck();
  await page.locator('#protocol').selectOption('profile');
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Report ready', { timeout: 90000 });
  const profileDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download report JSON', exact: true }).click();
  const profileFile = (await (await profileDownload).path())!;
  const profile = JSON.parse(await readFile(profileFile, 'utf8')).entries[0].runs[0];
  expect(['supported', 'unsupported']).toContain(profile.profiling.status);
  if (profile.profiling.status === 'supported')
    expect(
      profile.metrics.some((metric: { descriptor: { id: string } }) => metric.descriptor.id === 'gpu.pass-sum'),
    ).toBe(true);

  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive');
  const imageDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Capture converged PNG', exact: true }).click();
  const image = await imageDownload;
  expect(image.suggestedFilename()).toMatch(/\.png$/);
  await image.saveAs(testInfo.outputPath('capture.png'));
  const imageStats = await sharp(await readFile((await image.path())!)).stats();
  expect(imageStats.channels[0]!.stdev).toBeGreaterThan(5); // catches an empty canvas snapshot
  const { data, info } = await sharp(await readFile((await image.path())!))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let coloredPixels = 0;
  for (let index = 0; index < data.length; index += info.channels)
    if (Math.abs(data[index]! - data[index + 1]!) > 30) coloredPixels++;
  expect(coloredPixels).toBeGreaterThan(info.width * info.height * 0.05); // verifies Cornell geometry survived reloads
  await expect(page.getByRole('button', { name: 'Run benchmark', exact: true })).toBeEnabled();
  await page.locator('#duration').fill('5');
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect(page.locator('#message')).toContainText('cancelled', { timeout: 90000 });
  await expect(page.getByRole('button', { name: 'Load scene', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('playground.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('URL restores every control and the camera on refresh', async ({ page }) => {
  await page.goto(
    '/?scene=ssgi-basic&renderer=three-new&experiment=baseline&width=160&height=120&live-gpu=0&protocol=throughput&motion=orbit&duration=0.2&repeats=2&warmup=3&seed=42&compare=1&camera=1,10,30&target=0,7,0',
  );
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#protocol')).toHaveValue('throughput');
  await expect(page.locator('#motion')).toHaveValue('orbit');
  await expect(page.locator('#seed')).toHaveValue('42');
  await expect(page.locator('#compare')).toBeChecked();
  await page.locator('#repeats').fill('4');
  await page.locator('#repeats').dispatchEvent('change');
  const pose = new URL(page.url()).searchParams.get('camera');
  await page.reload();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#repeats')).toHaveValue('4');
  const restored = new URL(page.url()).searchParams.get('camera')!.split(',').map(Number);
  pose!
    .split(',')
    .map(Number)
    .forEach((value, index) => expect(restored[index]).toBeCloseTo(value, 8));
  await expect(page.getByText('See it. Measure it.')).toHaveCount(0);
});

test('combined hierarchy renders both effects, survives resize and camera motion, and exports its benchmark', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    '/?scene=ssgi-metallic&renderer=three-new&experiment=hierarchy-combined&width=161&height=121&live-gpu=0&protocol=throughput&duration=0.1&repeats=1&warmup=3',
  );
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#experiment')).toHaveValue('hierarchy-combined');
  const canvas = page.locator('#viewport canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2 + 5);
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get('camera')).not.toBeNull();
  await page.locator('#width').fill('193');
  await page.locator('#height').fill('145');
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  const savedImage = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Capture converged PNG', exact: true }).click();
  const stats = await sharp(await readFile((await (await savedImage).path())!)).stats();
  expect(stats.channels[0]!.stdev).toBeGreaterThan(5);
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Report ready', { timeout: 90000 });
  const savedReport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download report JSON', exact: true }).click();
  const report = JSON.parse(await readFile((await (await savedReport).path())!, 'utf8'));
  expect(report.entries[0].experiment).toBe('hierarchy-combined');
  expect(report.entries[0].workload.settings.ssgi).toBeTruthy();
  expect(report.entries[0].workload.settings.ssr).toBeTruthy();
  expect(errors).toEqual([]);
});

test('SSGI work experiments render and survive URL restoration', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const experiment of ['ssgi-early-exit', 'ssgi-reuse-texels', 'ssgi-redundant-work', 'ssgi-4x32']) {
    await page.goto(`/?scene=ssgi-basic&renderer=three-new&experiment=${experiment}&width=160&height=120`);
    await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
    await expect(page.locator('#experiment')).toHaveValue(experiment);
    await expect(page.locator('#gauge-cpu')).toContainText('ms');
    const pixels = await sharp(await page.locator('#viewport canvas').screenshot()).stats();
    expect(pixels.channels[0]!.stdev).toBeGreaterThan(5);
  }
  await page.reload();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#experiment')).toHaveValue('ssgi-4x32');
  expect(errors).toEqual([]);
});

test('switching scenes resets the camera despite movement before loading', async ({ page }) => {
  const vector = (name: string) => new URL(page.url()).searchParams.get(name)?.split(',').map(Number);
  const expectVector = (name: string, expected: number[]) => {
    const actual = vector(name)!;
    expect(actual).toHaveLength(3);
    expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 8));
  };
  await page.goto('/?scene=ssgi-basic&renderer=three-new&width=160&height=120&camera=1,10,30&target=0,7,0');
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  expectVector('camera', [1, 10, 30]);
  expectVector('target', [0, 7, 0]);

  // Select a differently sized scene, then move the still-active old camera.
  await page.locator('#scene').selectOption('ssr-steampunk-camera');
  const box = (await page.locator('#viewport canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(1200); // Allow the throttled camera URL update to run.
  expect(vector('camera')).toBeUndefined();
  expect(vector('target')).toBeUndefined();
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect.poll(() => vector('camera')).toBeDefined();
  expectVector('camera', [3, 2, 3]);
  expectVector('target', [0, 0, 0]);

  // Movement within this scene survives a renderer/settings reload.
  await page.mouse.wheel(0, 200);
  await expect.poll(() => vector('camera')).not.toEqual([3, 2, 3]);
  const pose = vector('camera')!;
  await page.locator('#live-gpu').check();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  expectVector('camera', pose);
  expectVector('target', [0, 0, 0]);

  await page.locator('#scene').selectOption('ssgi-basic');
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect.poll(() => vector('camera')).toBeDefined();
  expectVector('camera', [0, 10, 30]);
});

test('progressive light bake converges, remains interactive while orbiting and switches cleanly', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  let converged = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.endsWith('/favicon.ico')) errors.push(m.text());
    if (m.text().includes('Light bake:') && m.text().includes('converged')) converged++;
  });
  await page.goto('/?scene=ssgi-basic&renderer=three-new-light-bake&width=320&height=240');
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect.poll(() => converged, { timeout: 90000 }).toBe(1);
  await expect(page.locator('#bake-status')).toHaveText('Indirect lighting baked');
  await page.evaluate(async () => {
    for (let i = 0; i < 64; i++) await new Promise(requestAnimationFrame);
  });
  const bakedImage = await page.locator('#viewport canvas').screenshot();
  const face = await sharp(bakedImage).extract({ left: 100, top: 135, width: 35, height: 35 }).stats();
  // This white box face is unlit in the direct-only image. Require visible baked bounce lighting.
  expect(face.channels.slice(0, 3).every((channel) => channel.mean > 30)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('light-bake-live.png'), fullPage: true });
  const box = (await page.locator('#viewport canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 15, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get('camera')).not.toBeNull();
  await expect(page.locator('#live-status')).toHaveText('Interactive');
  expect(converged).toBe(1);
  await page.locator('#renderer').selectOption('three-new');
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  expect(errors).toEqual([]);
});
