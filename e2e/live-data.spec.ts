import { test, expect } from '@playwright/test';
import {
  mockHistory,
  mockStream,
  installFakeEventSource,
  fakeEventSourceUrls,
  tickerFrame,
  klineFrame,
  mockSymbols,
} from './helpers/live-data';

test.describe('Live data and chart controls (authenticated)', () => {
  test('StreamHealth shows nothing when live and reconnect text when fake stream drops', async ({
    page,
  }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 50000),
      klineFrame('BTCUSDT', '1h', 50000),
    ]);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    // StreamHealth renders null when status is 'live'
    await expect(page.getByText('Reconnecting to live prices.')).not.toBeVisible();
    await expect(page.getByText('Live prices paused. Showing the last update.')).not.toBeVisible();
    await expect(page.getByText('Live prices are offline.')).not.toBeVisible();

    const initialUrls = await fakeEventSourceUrls(page);

    // Drop the fake stream
    await page.evaluate(() => {
      window.__esFail?.({ closed: true });
    });

    // StreamHealth displays the reconnect text
    const healthNotice = page.getByText(
      /Reconnecting to live prices\.|Live prices paused\. Showing the last update\.|Live prices are offline\./
    );
    await expect(healthNotice).toBeVisible({ timeout: 10000 });

    const finalUrls = await fakeEventSourceUrls(page);
    expect(finalUrls.length).toBeGreaterThanOrEqual(initialUrls.length);
  });

  test('interval segmented control changes interval and kline stream name changes', async ({
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

  test('coin tabs select coin and streams selected coin klines', async ({ page }) => {
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

  test('history load failure displays StateNotice and Try again reloads successfully', async ({
    page,
  }) => {
    await mockHistory(page, { fail: true });
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    await expect(page.getByText('The chart did not load.')).toBeVisible({ timeout: 15000 });

    await page.unroute('**/api/prices/history**');
    await mockHistory(page);

    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('The chart did not load.')).not.toBeVisible({ timeout: 10000 });
  });
});
