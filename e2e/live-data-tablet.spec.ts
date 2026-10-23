import { test, expect } from '@playwright/test';
import { mockHistory, mockStream, installFakeEventSource, mockSymbols } from './helpers/live-data';

test.describe('Live data tablet layout and interactions', () => {
  test('More sheet opens and closes on Escape, or coin search palette toggles watchlist', async ({
    page,
  }) => {
    await mockHistory(page);
    await mockSymbols(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const viewport = page.viewportSize();
    const isSheetWidth = (viewport?.width ?? 0) < 1024;

    if (isSheetWidth) {
      const moreButton = page.getByRole('button', { name: 'More' });
      await moreButton.click();

      const sheet = page.getByRole('dialog');
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('heading', { name: 'More' })).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible();
    } else {
      await page.getByRole('button', { name: 'Search coins' }).click();
      const dialog = page.getByRole('dialog', { name: 'Search coins' });
      await expect(dialog).toBeVisible();

      const toggleButton = dialog.getByRole('button', { name: /watchlist/i }).first();
      await expect(toggleButton).toBeVisible();
      const initialText = await toggleButton.innerText();
      await toggleButton.click();
      const expectedText = initialText.includes('Add')
        ? 'Remove from watchlist'
        : 'Add to watchlist';
      await expect(toggleButton).toHaveText(expectedText);
    }
  });

  test('status badge is visible and reaches Live', async ({ page }) => {
    await mockHistory(page);
    await installFakeEventSource(page);

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
