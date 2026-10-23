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
  test('stream status badge reaches Live and watchlist displays streamed price', async ({ page }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 12345.67),
      klineFrame('BTCUSDT', '1h', 12345.67),
    ]);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await expect(page.getByRole('status', { name: 'Live' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('12,345.67').first()).toBeVisible({ timeout: 10000 });
  });

  test('stream reconnects within 10 s and returns to Live badge', async ({ page }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 50000),
      klineFrame('BTCUSDT', '1h', 50000),
    ]);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('status', { name: 'Live' })).toBeVisible({ timeout: 10000 });

    const initialUrls = await fakeEventSourceUrls(page);

    await page.evaluate(() => {
      window.__esFail?.({ closed: true });
    });

    await expect(page.getByRole('status', { name: 'Reconnecting' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('status', { name: 'Live' })).toBeVisible({ timeout: 10000 });

    const finalUrls = await fakeEventSourceUrls(page);
    expect(finalUrls.length).toBeGreaterThanOrEqual(initialUrls.length + 1);
  });

  test('interval switch to 4H activates tab and streams 4h klines', async ({ page }) => {
    await mockHistory(page);
    const streamUrls = await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const tab4h = page.getByRole('tab', { name: '4H' });
    await tab4h.click();
    await expect(tab4h).toHaveAttribute('data-state', 'active');

    await expect
      .poll(() => streamUrls.some((url) => url.includes('btcusdt@kline_4h')), { timeout: 10000 })
      .toBe(true);
  });

  test('choosing 1M from More menu deactivates primary tabs and streams monthly klines', async ({ page }) => {
    await mockHistory(page);
    const streamUrls = await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /^More$/ }).click();
    await page.getByRole('menuitem', { name: '1M' }).click();

    await expect(page.locator('[role="tab"][data-state="active"]')).toHaveCount(0);
    await expect
      .poll(() => streamUrls.some((url) => url.includes('btcusdt@kline_1M')), { timeout: 10000 })
      .toBe(true);
  });

  test('symbol switch to ETH in watchlist streams ethusdt klines', async ({ page }) => {
    await mockHistory(page);
    await mockSymbols(page);
    const streamUrls = await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Search coins' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search coins' });
    await expect(dialog).toBeVisible();
    await dialog.getByText('ETH', { exact: true }).click();

    await expect(page).toHaveURL('/focus?symbol=ETHUSDT', { timeout: 10000 });

    await expect
      .poll(() => streamUrls.some((url) => url.includes('ethusdt@kline_')), { timeout: 10000 })
      .toBe(true);
  });

  test('indicator toggle flips checked state in menu', async ({ page }) => {
    await mockHistory(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const trigger = page.getByRole('button', { name: 'Indicators' });
    await trigger.click();

    const bollItem = page.getByRole('menuitemcheckbox', { name: 'Bollinger Bands' });
    await expect(bollItem).toHaveAttribute('aria-checked', 'false');
    await bollItem.click();

    if (!(await bollItem.isVisible().catch(() => false))) {
      await trigger.click();
    }
    await expect(page.getByRole('menuitemcheckbox', { name: 'Bollinger Bands' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('drawing tool activates and deactivates on click', async ({ page }) => {
    await mockHistory(page);
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const trendlineButton = page.getByRole('button', { name: 'Trendline' });
    await expect(trendlineButton).toHaveAttribute('data-variant', 'ghost');

    await trendlineButton.click();
    await expect(trendlineButton).toHaveAttribute('data-variant', 'secondary');

    await trendlineButton.click();
    await expect(trendlineButton).toHaveAttribute('data-variant', 'ghost');
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

  test('history load failure displays alert and Retry reloads successfully', async ({ page }) => {
    await mockHistory(page, { fail: true });
    await mockStream(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await expect(page.getByText('Could not load price history.')).toBeVisible({ timeout: 15000 });

    await page.unroute('**/api/prices/history**');
    await mockHistory(page);

    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Could not load price history.')).not.toBeVisible({ timeout: 10000 });
  });

  test('offline mode switches badge to Offline and recovers to Live on reconnect', async ({
    page,
    context,
  }) => {
    await mockHistory(page);
    await installFakeEventSource(page);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('status', { name: 'Live' })).toBeVisible({ timeout: 15000 });

    await context.setOffline(true);
    await expect(page.getByRole('status', { name: 'Offline' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Retry live data' })).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByRole('status', { name: 'Live' })).toBeVisible({ timeout: 10000 });
  });
});
