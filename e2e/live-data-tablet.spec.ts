import { test, expect } from '@playwright/test';
import {
  mockHistory,
  mockStream,
  installFakeEventSource,
  mockSymbols,
} from './helpers/live-data';

test.describe('Live data tablet layout and interactions', () => {
  test('More sheet opens and closes on Escape, or coin search palette toggles watchlist', async ({
    page,
  }) => {
    await mockHistory(page);
    await mockSymbols(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

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

  test('StreamHealth shows nothing when live and reconnect text when fake stream drops', async ({
    page,
  }) => {
    await mockHistory(page);
    await installFakeEventSource(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    await expect(page.getByText('Reconnecting to live prices.')).not.toBeVisible();
    await expect(page.getByText('Live prices paused. Showing the last update.')).not.toBeVisible();
    await expect(page.getByText('Live prices are offline.')).not.toBeVisible();

    await page.evaluate(() => {
      window.__esFail?.({ closed: true });
    });

    const healthNotice = page.getByText(
      /Reconnecting to live prices\.|Live prices paused\. Showing the last update\.|Live prices are offline\./
    );
    await expect(healthNotice).toBeVisible({ timeout: 10000 });
  });

  test('interval segmented control changes interval and streams klines on tablet', async ({
    page,
  }) => {
    await mockHistory(page);
    const streamUrls = await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const radio4h = page.getByRole('radio', { name: '4H' });
    await page.getByText('4H', { exact: true }).click();
    await expect(radio4h).toBeChecked();

    await expect
      .poll(() => streamUrls.some((url) => url.includes('btcusdt@kline_4h')), { timeout: 10000 })
      .toBe(true);
  });

  test('coin tabs select coin and stream selected coin klines on tablet', async ({
    page,
  }) => {
    await mockHistory(page);
    await mockSymbols(page);
    const streamUrls = await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const ethTab = page.getByRole('tablist', { name: 'Watchlist' }).getByRole('tab', { name: /ETH/ });
    await ethTab.click();
    await expect(ethTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('ETH / USDT')).toBeVisible();

    await expect
      .poll(() => streamUrls.some((url) => url.includes('ethusdt@kline_')), { timeout: 10000 })
      .toBe(true);
  });
});
