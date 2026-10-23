import { test, expect } from '@playwright/test';
import {
  mockHistory,
  installFakeEventSource,
  fakeEventSourceUrls,
  tickerFrame,
  closedKlineFrame,
  mockLevels,
  mockLab,
} from './helpers/live-data';

function getYesterdayUtcMidnight(): number {
  const now = Date.now();
  const todayMidnight = Math.floor(now / 86_400_000) * 86_400_000;
  return todayMidnight - 86_400_000;
}

function defaultLevels() {
  const yesterdayMidnight = getYesterdayUtcMidnight();
  return {
    BTCUSDT: {
      high: 110,
      low: 90,
      close: 100,
      atr: 20,
      dayStart: yesterdayMidnight,
    },
    ETHUSDT: {
      high: 5000,
      low: 4000,
      close: 4500,
      atr: 50,
      dayStart: yesterdayMidnight,
    },
  };
}

test.describe('When to look panel and watchlist level line', () => {
  test('panel headline names the coin near a level', async ({ page }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 108),
      tickerFrame('ETHUSDT', 3000),
    ]);
    await mockLevels(page, defaultLevels());
    await page.goto('/dashboard');

    const panel = page.getByRole('region', { name: 'When to look' });
    await expect(panel).toBeVisible();

    const headline = panel.getByTestId('look-headline');
    await expect(headline).toContainText('BTC is 0.1 ATR below the prev high', { timeout: 10000 });

    const levelsDd = panel.locator('dt:has-text("Levels") + dd');
    await expect(levelsDd).toContainText('BTC');
  });

  test('panel shows nothing to look at when prices are live and nothing is near', async ({
    page,
  }) => {
    const yesterdayMidnight = getYesterdayUtcMidnight();
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 108),
      tickerFrame('ETHUSDT', 3000),
    ]);
    await mockLevels(page, {
      BTCUSDT: {
        high: 500,
        low: 400,
        close: 450,
        atr: 20,
        dayStart: yesterdayMidnight,
      },
      ETHUSDT: {
        high: 5000,
        low: 4000,
        close: 4500,
        atr: 50,
        dayStart: yesterdayMidnight,
      },
    });
    await page.goto('/dashboard');

    const panel = page.getByRole('region', { name: 'When to look' });
    await expect(panel).toBeVisible();

    const headline = panel.getByTestId('look-headline');
    await expect(headline).toHaveText('Nothing needs a look right now.', { timeout: 10000 });
  });

  test('stream failure turns the headline into a look reason and Retry recovers', async ({
    page,
  }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 108),
      tickerFrame('ETHUSDT', 3000),
    ]);
    await mockLevels(page, defaultLevels());
    await page.goto('/dashboard');

    const panel = page.getByRole('region', { name: 'When to look' });
    await expect(panel).toBeVisible();

    await page.evaluate(() => {
      window.__esFail?.();
    });

    const headline = panel.getByTestId('look-headline');
    await expect(headline).toContainText('prices are', { timeout: 10000 });

    const retryBtn = panel.getByRole('button', { name: 'Reconnect live prices' });
    await expect(retryBtn).toBeVisible();

    await retryBtn.click();
    await page.evaluate((frame) => {
      window.__esPush?.(frame);
    }, tickerFrame('BTCUSDT', 108));

    await expect(headline).not.toContainText('prices are', { timeout: 10000 });
  });

  test('bar arrival lag appears after a closed 1-minute bar', async ({ page }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 108),
      tickerFrame('ETHUSDT', 3000),
    ]);
    await mockLevels(page, defaultLevels());
    await page.goto('/dashboard');

    const panel = page.getByRole('region', { name: 'When to look' });
    await expect(panel).toBeVisible();

    await expect
      .poll(
        async () =>
          (await fakeEventSourceUrls(page)).some((u) =>
            decodeURIComponent(u).includes('btcusdt@kline_1m')
          ),
        { timeout: 10000 }
      )
      .toBe(true);

    await page.evaluate((frame) => {
      window.__esPush?.(frame);
    }, closedKlineFrame('BTCUSDT', '1m', Date.now() - 500, 108));

    const barArrivalDd = panel.locator('dt:has-text("Bar arrival") + dd');
    await expect(barArrivalDd).toHaveText(/arrived \d+\.\d s after it closed/, { timeout: 10000 });
  });

  test('forward lab error shows Retry', async ({ page }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 108),
      tickerFrame('ETHUSDT', 3000),
    ]);
    await mockLevels(page, defaultLevels());
    await mockLab(page, {}, { fail: true });
    await page.goto('/dashboard');

    const panel = page.getByRole('region', { name: 'When to look' });
    await expect(panel).toBeVisible();

    await expect(panel.getByText('Could not load the forward lab.')).toBeVisible({ timeout: 10000 });
    const retryBtn = panel.getByRole('button', { name: 'Retry forward lab' });
    await expect(retryBtn).toBeVisible();

    await page.unroute('**/api/signals/lab');
    await mockLab(page, {
      version: 'lab-v1',
      threshold: 800,
      hypotheses: [
        {
          id: 'L1-8h',
          candidate: 'L1',
          timeframe: '8h',
          status: 'under_test',
          underTestSince: null,
          testEndsAt: null,
          validatedAt: null,
          gradedBars: 1,
          betBars: 1,
          e: 1.02,
          e0: 1,
          threshold: 800,
          meanX: 0,
          meanB: 0,
          currentB: 0,
          latestBar: null,
        },
      ],
    });

    await retryBtn.click();
    await expect(panel.getByText(/1 of 1 hypotheses under test/)).toBeVisible({ timeout: 10000 });
  });


  test('panel has no horizontal overflow', async ({ page }) => {
    await mockHistory(page);
    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 108),
      tickerFrame('ETHUSDT', 3000),
    ]);
    await mockLevels(page, defaultLevels());
    await page.goto('/dashboard');

    const panel = page.getByRole('region', { name: 'When to look' });
    await expect(panel).toBeVisible();

    const noOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth;
    });
    expect(noOverflow).toBe(true);
  });
});
