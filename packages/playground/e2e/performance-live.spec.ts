import { expect, test } from '@playwright/test';
import sharp from 'sharp';

test('live benchmark defers selections, resets charts and renders at 1080p with local telemetry', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /THREE|shader|WebGPU/i.test(message.text())) errors.push(message.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { harnessMessages: unknown[] }).harnessMessages = [];
    window.addEventListener('message', (event) => {
      if (event.data?.protocol === 'performance-kit')
        (window as unknown as { harnessMessages: unknown[] }).harnessMessages.push(event.data);
    });
  });
  await page.goto('/performance.html');
  const start = page.getByRole('button', { name: 'Start Benchmark' });
  await expect(page.locator('.live-viewport canvas')).toHaveCount(0);
  await start.click();
  await expect(page.getByRole('status')).toHaveText('Running', { timeout: 90000 });
  const canvas = page.locator('.live-viewport canvas');
  await expect(canvas).toHaveAttribute('width', '1920');
  await expect(canvas).toHaveAttribute('height', '1080');
  await expect(page.getByLabel('Setup time chart')).toContainText('compile');
  await expect(page.getByLabel('Live frame rate')).not.toHaveText('— FPS');
  await expect.poll(() => page.locator('[aria-label="Frame rate chart"] circle').count()).toBeGreaterThan(1);

  const baseCapture = await canvas.screenshot({ path: testInfo.outputPath('three-base.png') });
  const stats = await sharp(baseCapture).stats();
  expect(Math.max(...stats.channels.slice(0, 3).map((channel) => channel.stdev))).toBeGreaterThan(10);
  expect(errors).toEqual([]);

  // Keyboard controls must change the rendered camera, not scroll the page.
  await canvas.focus();
  const before = await canvas.screenshot();
  await page.keyboard.down('w');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  const after = await canvas.screenshot();
  expect(after.equals(before)).toBe(false);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(150);
  await page.keyboard.up('ArrowLeft');

  await page.getByLabel('Scene', { exact: true }).selectOption('cornell-box-basic-oblique');
  await page.getByLabel('Renderer', { exact: true }).selectOption('three-new-ssgi-2x8');
  await expect(page.getByText('Selection changed. Click Start Benchmark to apply.')).toBeVisible();
  await expect(page.locator('.live-summary h2')).toHaveText('cornell-box-basic / three-current');
  await expect(page.getByRole('status')).toHaveText('Running');
  await start.click();
  await expect(page.getByLabel('Setup time chart')).toContainText('Setup measurements appear');
  await expect(page.locator('[aria-label="Frame rate chart"] circle')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Running', { timeout: 90000 });
  await expect(page.locator('.live-summary h2')).toHaveText('cornell-box-basic-oblique / three-new-ssgi-2x8');
  await expect(page.getByLabel('Live frame rate')).not.toHaveText('— FPS');
  expect(await page.evaluate(() => (window as unknown as { harnessMessages: unknown[] }).harnessMessages)).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('performance-live.png'), fullPage: true });
});
