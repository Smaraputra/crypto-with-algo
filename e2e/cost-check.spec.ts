import { test, expect, type Page } from '@playwright/test';

/**
 * Cost Check (authenticated). Binance may be unreachable from the test
 * machine, so the market-facts API is answered from a fixture: the page's own
 * arithmetic then gives a deterministic verdict.
 */

const MARKET = {
  symbol: 'BTCUSDT',
  asOf: Date.UTC(2026, 9, 7, 9, 30),
  stale: false,
  markPrice: 60000,
  funding: { rate: 0, intervalHours: 8, nextFundingTime: Date.UTC(2030, 0, 1) },
  venue: { minNotional: 50, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, effectiveMinNotional: 60 },
  measurement: { interval: '15m', holdBars: 4, measuredHoldMs: 3_600_000, barsUsed: 999 },
  move: { medianPercent: 0.3, meanPercent: 0.4, p75Percent: 0.55, samples: 995, independentWindows: 249 },
  slippage: { bps: 1, source: 'depth', halfSpreadBps: 0.1, exceedsTopOfBook: false },
  onboardDate: 0,
};

async function stubApi(page: Page, market: unknown = MARKET, status = 200) {
  await page.route('**/api/cost-check/symbols', (route) =>
    route.fulfill({
      json: {
        symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 0 },
          { symbol: 'ETHUSDT', baseAsset: 'ETH', onboardDate: 0 },
        ],
        asOf: 0,
        stale: false,
      },
    })
  );
  // The page only prices a hold with a move measured for that hold, so answer per hold.
  const measurements: Record<string, { interval: string; holdBars: number; measuredHoldMs: number }> = {
    '60': { interval: '15m', holdBars: 4, measuredHoldMs: 3_600_000 },
    '420': { interval: '1h', holdBars: 7, measuredHoldMs: 7 * 3_600_000 },
    '10080': { interval: '1d', holdBars: 7, measuredHoldMs: 7 * 86_400_000 },
  };
  await page.route('**/api/cost-check?*', (route) => {
    if (status !== 200) return route.fulfill({ status, json: market });
    const url = new URL(route.request().url());
    const hold = url.searchParams.get('holdMinutes') ?? '60';
    const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT';
    const measurement = measurements[hold];
    return route.fulfill({
      json: { ...(market as typeof MARKET), symbol, measurement: { ...measurement, barsUsed: 999 } },
    });
  });
}

test.describe('Cost Check (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    // Start every test from the defaults, whatever an earlier test saved.
    await page.addInitScript(() => window.localStorage.removeItem('cost-check:v1'));
  });

  test('is reachable from the sidebar', async ({ page }) => {
    await stubApi(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });
    await page.locator('[data-testid="desktop-sidebar"]').getByRole('link', { name: 'Cost Check' }).click();
    await expect(page).toHaveURL('/cost-check', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Cost Check' })).toBeVisible();
  });

  test('gives the breakeven win rate for the default trade', async ({ page }) => {
    await stubApi(page);
    await page.goto('/cost-check');
    await expect(page.getByTestId('cost-check-tone')).toHaveText('Costs dominate', { timeout: 15000 });
    // taker 0.05% x 2 + 1 bp x 2 = 0.12%; 0.5 + 0.12 / (2 x 0.40) = 65.0%
    await expect(page.getByTestId('cost-check-verdict')).toContainText('more than 65.0% of the time');
    await expect(page.getByTestId('cost-check-breakdown')).toContainText('0.1200%');
  });

  test('recomputes when the hold changes', async ({ page }) => {
    await stubApi(page);
    await page.goto('/cost-check');
    await expect(page.getByTestId('cost-check-tone')).toBeVisible({ timeout: 15000 });
    await page.getByText('1w', { exact: true }).click();
    await expect(page.getByTestId('cost-check-verdict')).toContainText('of a 7d hold');
  });

  test('opens on the trade in the URL', async ({ page }) => {
    await stubApi(page);
    await page.goto('/cost-check?symbol=ETHUSDT&holdMinutes=420&notional=248');
    await expect(page.getByTestId('cost-check-symbol')).toHaveText('ETHUSDT', { timeout: 15000 });
    await expect(page.getByTestId('cost-check-notional')).toHaveText('Position 248.00 USDT');
  });

  test('still prices the trade when the exchange is unreachable', async ({ page }) => {
    await stubApi(page, { error: 'venue_unreachable', message: 'unreachable' }, 503);
    await page.goto('/cost-check');
    await expect(page.getByTestId('cost-check-verdict')).toContainText('Market data is unavailable', { timeout: 15000 });
    await expect(page.getByTestId('cost-check-breakdown')).toContainText('flat assumption, no order book');
  });
});
