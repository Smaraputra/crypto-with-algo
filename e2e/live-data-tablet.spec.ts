import { test, expect } from '@playwright/test';
import { mockHistory, mockStream } from './helpers/live-data';

test.describe('Live data tablet layout and interactions', () => {
  test('navigation sheet closes on symbol selection or asserts selection on desktop sidebar', async ({
    page,
  }) => {
    await mockHistory(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const viewport = page.viewportSize();
    const isSheetWidth = (viewport?.width ?? 0) < 1024;

    if (isSheetWidth) {
      const menuButton = page.getByRole('button', { name: 'Open menu' });
      await menuButton.click();

      const sheet = page.getByRole('dialog');
      await expect(sheet).toBeVisible();

      const ethButton = sheet.getByRole('button').filter({ hasText: /^ETH/ }).first();
      await ethButton.click();

      await expect(sheet).not.toBeVisible();
    } else {
      const ethButton = page.locator('aside').getByRole('button').filter({ hasText: /^ETH/ }).first();
      await ethButton.click();
      await expect(ethButton).toHaveClass(/bg-sidebar-accent/);
    }
  });

  test('status badge is visible and reaches Live', async ({ page }) => {
    await mockHistory(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await expect(page.getByRole('status', { name: 'Live' })).toBeVisible({ timeout: 15000 });
  });

  test('CSS overlay fallback exits on Escape', async ({ page }) => {
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = function () {
        return Promise.reject(new Error('denied'));
      };
    });
    await mockHistory(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const fullscreenBtn = page.getByRole('button', { name: 'Enter fullscreen' });
    await fullscreenBtn.click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  });

  test('fullscreen button toggles back', async ({ page }) => {
    await mockHistory(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const fullscreenBtn = page.getByRole('button', { name: 'Enter fullscreen' });
    await fullscreenBtn.click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();

    const exitBtn = page.getByRole('button', { name: 'Exit fullscreen' });
    await exitBtn.click();
    await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  });
});
