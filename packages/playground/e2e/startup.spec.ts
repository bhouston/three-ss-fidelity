import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('startup explains every live load, captures bounded early shader work, and exports its data', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?scene=ssgi-basic&renderer=three-new&width=128&height=96');
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#startup')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#startup-coverage')).toContainText('Capture finished', { timeout: 90000 });
  await expect(page.locator('#startup-stages')).toContainText('Page + JavaScript loading');
  await page.locator('.startup-details summary').click();
  await expect(page.locator('#startup-passes')).toContainText('NewSSRNode.SSR');
  await expect(page.locator('#startup-shaders')).toContainText('Exact GPU compiler time is not exposed');
  await page.screenshot({ path: testInfo.outputPath('startup.png'), fullPage: true });
  async function data() {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download startup JSON' }).click();
    return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  }
  const first = await data();
  expect(first.frames).toBe(4);
  expect(first.pipelines).toBeGreaterThan(0);
  expect(first.phases.scene).toBeGreaterThanOrEqual(0);
  expect(first.phases['gpu-wait']).toBeGreaterThanOrEqual(0);
  expect(first.settings.width).toBe(128);
  expect(first.pageMs).toBeGreaterThan(0);
  const stageSum = Object.values(first.phases).reduce<number>(
    (sum, value) => sum + Number(value),
    first.pageMs + first.otherMs,
  );
  expect(stageSum).toBeCloseTo(first.totalMs, 3);
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#startup-coverage')).toContainText('Capture finished', { timeout: 90000 });
  await expect(page.locator('#startup-stages')).not.toContainText('Page + JavaScript loading');
  const second = await data();
  expect(second.pageMs).toBe(0);
  expect(second.frames).toBe(4);
  expect(second.pipelines).toBe(first.pipelines); // fresh capture, not accumulated across loads
  await page.locator('#renderer').selectOption('three-current');
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#startup-coverage')).toContainText('Capture finished', { timeout: 90000 });
  const stock = await data();
  expect(stock.renderer).toBe('three-current');
  expect(stock.shaderReport.builders.length).toBeGreaterThan(0);
  expect(stock.frames).toBe(4);
  expect(errors).toEqual([]);
});

test('an invalid load fails visibly and a subsequent valid load replaces the failure', async ({ page }) => {
  await page.goto('/?scene=traa-checker&renderer=three-new&width=0&height=96');
  await expect(page.locator('#startup')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#live-status')).toHaveText('Needs attention');
  await page.locator('#width').fill('128');
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#startup')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#startup-shaders')).not.toContainText('Dimensions');
  await page.locator('#width').fill('0');
  await page.getByRole('button', { name: 'Load scene', exact: true }).click();
  await expect(page.locator('#startup')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#startup-total')).toHaveText('—');
  await expect(page.locator('#startup-passes tr')).toHaveCount(0);
});
