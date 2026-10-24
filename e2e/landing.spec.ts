import { test, expect } from '@playwright/test';
import {
  installFakeEventSource,
  tickerFrame,
  klineFrame,
} from './helpers/live-data';

const mockTickers = [
  { symbol: 'BTCUSDT', lastPrice: '65000.00', priceChangePercent: '-2.50' },
  { symbol: 'ETHUSDT', lastPrice: '3500.00', priceChangePercent: '1.20' },
  { symbol: 'SOLUSDT', lastPrice: '150.00', priceChangePercent: '4.80' },
];

test.describe('Landing page (unauthenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/prices', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockTickers),
      });
    });
  });

  test('renders hero heading with exactly one h1', async ({ page }) => {
    await page.goto('/');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText('A crypto market tracker with an open research lab');
    await expect(h1).toBeVisible();
  });

  test('desktop bar shows navigation links, login, and registration links', async ({ page }) => {
    await page.goto('/');
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('link', { name: 'Features', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'How it works', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Blog', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Log in', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Create a free account', exact: true })).toBeVisible();
  });

  test('Log in link navigates to /login', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Log in', exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('Create a free account link navigates to /register', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Create a free account', exact: true }).first().click();
    await expect(page).toHaveURL(/\/register/);
  });

  test('live prices shows BTC ticker and negative change with minus sign', async ({ page }) => {
    await page.goto('/');
    const livePrices = page.getByRole('list', { name: 'Live prices' });
    await expect(livePrices).toBeVisible();
    await expect(livePrices).toContainText('BTC');
    await expect(livePrices).toContainText('-2.50%');
  });

  test('globe wrapper box exists with a nonzero size', async ({ page }) => {
    await page.goto('/');
    const globeWrapper = page.getByTestId('hero-globe');
    await expect(globeWrapper).toBeVisible();

    const box = await globeWrapper.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
  });

  test('reduced motion renders hero h1 and evidence caption', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    await expect(h1).toHaveText('A crypto market tracker with an open research lab');

    const caption = page.getByText('Illustration, not live data.');
    await expect(caption).toBeVisible();
  });

  test('live ticker and live candle chart show moving market data', async ({ page }) => {
    const now = Date.now();
    const currentHour = now - (now % (3600 * 1000));
    const mockCandles = Array.from({ length: 48 }, (_, i) => {
      const timestamp = currentHour - (47 - i) * 3600 * 1000;
      const base = 64000 + i * 20;
      return {
        t: timestamp,
        o: base,
        h: base + 50,
        l: base - 50,
        c: i === 47 ? 65000 : base + 20,
        v: 100 + i,
      };
    });

    await page.route('**/api/public/candles**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockCandles),
      });
    });

    await installFakeEventSource(page, [
      tickerFrame('BTCUSDT', 65000),
      klineFrame('BTCUSDT', '1h', 65000),
    ]);

    await page.goto('/');

    const livePrices = page.getByRole('list', { name: 'Live prices' });
    await expect(livePrices).toBeVisible();
    await expect(livePrices).toContainText('$65,000.00');

    const candleChart = page.getByRole('img', { name: /^BTC hourly candles/ });
    await expect(candleChart).toBeVisible();
  });

  test('lab section renders honest research copy without hype', async ({ page }) => {
    await page.goto('/');
    const labHeading = page.getByRole('heading', { name: 'How evidence builds', exact: true });
    await expect(labHeading).toBeVisible();
    await expect(page.getByText('Ideas that fail stay on the lab record.')).toBeVisible();
    await expect(page.locator('body')).not.toHaveText(/public record|currently validated/i);
  });

  test('displays live lab counts above evidence tape illustration', async ({ page }) => {
    await page.route('**/api/public/lab-counts', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          underTest: 12,
          validated: 0,
          notStarted: 1,
          hypotheses: 13,
          rejectedRules: 1,
          ledgerTrials: 2204,
          asOf: new Date().toISOString(),
        }),
      });
    });

    await page.goto('/');
    await expect(page.getByText('Live now: 12 ideas under test on new market bars, 0 validated so far, and 2,204 trials recorded.')).toBeVisible();
  });

  test('footer shows legal links', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Terms', exact: true })).toBeVisible();
  });

  test('theme switch toggles dark class on html element', async ({ page }) => {
    await page.goto('/');
    const themeSwitch = page.getByRole('banner').getByRole('switch', { name: 'Dark' }).first();
    await expect(themeSwitch).toBeVisible();

    // The starting theme depends on the default and the browser's colour scheme, so flip from whatever it is
    const html = page.locator('html');
    const startsDark = ((await html.getAttribute('class')) ?? '').split(/\s+/).includes('dark');

    await themeSwitch.click();
    if (startsDark) await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    else await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);

    await themeSwitch.click();
    if (startsDark) await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
  });
});
