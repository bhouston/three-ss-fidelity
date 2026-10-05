import { expect, test } from '@playwright/test';

test('glTF transmission scene loads browser image textures and renders alpha cutouts', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?scene=khronos-transmission-test&renderer=three-new&width=320&height=240');
  await expect(page.locator('#live-status')).toHaveText('Interactive', { timeout: 90000 });
  await expect(page.locator('#scene')).toHaveValue('khronos-transmission-test');
  await expect(page.locator('#viewport canvas')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('transmission-test.png'), fullPage: true });
  expect(errors).toEqual([]);
});
