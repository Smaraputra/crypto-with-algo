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

const REGIME = {
  symbol: 'BTCUSDT',
  asOf: Date.UTC(2026, 9, 8, 0, 30),
  regime: {
    symbol: 'BTCUSDT',
    day: Date.UTC(2026, 9, 7),
    dayVolPercent: 2.41,
    thresholdVolPercent: 1.98,
    percentile: 93.9,
    high: true,
    trailingDays: 180,
  },
};

async function stubApi(page: Page, market: unknown = MARKET, status = 200) {
  // The regime endpoint is answered from a fixture too, so no test depends on reaching Binance.
  await page.route('**/api/cost-check/regime', (route) =>
    status === 200 ? route.fulfill({ json: REGIME }) : route.fulfill({ status, json: market })
  );
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

  test('is reachable from the Tools menu', async ({ page }) => {
    await stubApi(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('navigation', { name: 'Desktop primary' }).getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Cost Check' }).click();
    await expect(page).toHaveURL('/cost-check', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Cost Check' })).toBeVisible();
  });

  test('gives the breakeven win rate for the default trade', async ({ page }) => {
    await stubApi(page);
    await page.goto('/cost-check');
    await expect(page.getByTestId('cost-verdict-label')).toHaveText('Costs dominate', { timeout: 15000 });
    await expect(page.getByText('(65.0% win rate needed)')).toBeVisible();
    await expect(page.getByTestId('focal-round-trip-cost')).toHaveText('$1.20');
  });

  test('recomputes when the hold changes', async ({ page }) => {
    await stubApi(page);
    await page.goto('/cost-check');
    await expect(page.getByTestId('cost-verdict-label')).toBeVisible({ timeout: 15000 });

    const requestPromise = page.waitForRequest((req) => {
      const url = req.url();
      return url.includes('/api/cost-check?') && url.includes('holdMinutes=10080');
    });

    await page
      .getByRole('group', { name: 'Hold duration presets' })
      .getByText('1w', { exact: true })
      .click();

    await expect(page.getByLabel('Custom hold (minutes)', { exact: true })).toHaveValue('10080');
    await requestPromise;
  });

  test('opens on the trade in the URL', async ({ page }) => {
    await stubApi(page);
    await page.goto('/cost-check?symbol=ETHUSDT&holdMinutes=420&notional=248');
    await expect(page.getByRole('combobox', { name: 'Coin', exact: true })).toContainText('ETH', { timeout: 15000 });
    await expect(page.getByTestId('notional-display')).toHaveText('Position size: $248');
  });

  test('shows the market volatility regime beside the result', async ({ page }) => {
    await stubApi(page);
    await page.goto('/cost-check');
    await expect(page.getByText('High volatility regime')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Realised vol: 2.41%')).toBeVisible();
    await expect(page.getByText('41.4% of days')).toBeVisible();
  });

  test('still prices the trade when the exchange is unreachable', async ({ page }) => {
    await stubApi(page, { error: 'venue_unreachable', message: 'unreachable' }, 503);
    await page.goto('/cost-check');
    await expect(page.getByText('Live market data did not load: the exchange could not be reached.')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Slippage uses a flat 5 bps assumption')).toBeVisible();
    await expect(page.getByTestId('focal-round-trip-cost')).toBeVisible();
    await expect(page.getByText('Regime data did not load: the exchange could not be reached.')).toBeVisible();
  });
});
