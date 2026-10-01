import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

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
