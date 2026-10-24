import { test, expect } from '@playwright/test';
import {
  mockHistory,
  mockStream,
  mockSymbols,
  mockTrackBars,
  tickerFrame,
} from './helpers/live-data';

test.describe('Market screen (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await mockSymbols(page);
    await mockHistory(page);
    await mockTrackBars(page);
    await mockStream(page, [
      tickerFrame('BTCUSDT', 65000),
      tickerFrame('ETHUSDT', 3500),
    ]);
  });

  test('coin tabs render from watchlist and selecting ETH updates price heading area', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const tablist = page.getByRole('tablist', { name: 'Watchlist' });
    await expect(tablist).toBeVisible();

    const btcTab = tablist.getByRole('tab', { name: /BTC/ });
    const ethTab = tablist.getByRole('tab', { name: /ETH/ });
    await expect(btcTab).toBeVisible();
    await expect(ethTab).toBeVisible();

    await expect(page.getByText('BTC / USDT')).toBeVisible();

    await ethTab.click();
    await expect(ethTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('ETH / USDT')).toBeVisible();
  });

  test('interval control offers 1H, 4H, 1D, 1W and 1M, and choosing 4H marks it checked', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const intervalGroup = page.getByRole('group', { name: 'Interval' });
    await expect(intervalGroup).toBeVisible();

    for (const label of ['1H', '4H', '1D', '1W', '1M']) {
      await expect(page.getByRole('radio', { name: label })).toBeVisible();
    }

    await expect(page.getByRole('radio', { name: '1H' })).toBeChecked();

    await page.getByText('4H', { exact: true }).click();
    await expect(page.getByRole('radio', { name: '4H' })).toBeChecked();
  });

  test('"Study this coin" links to /focus?symbol=', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const studyLink = page.getByRole('link', { name: 'Study this coin' });
    await expect(studyLink).toBeVisible();
    await expect(studyLink).toHaveAttribute('href', /\/focus\?symbol=BTCUSDT/);
  });

  test('the Lab panel links to /lab', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const labLink = page.getByRole('link', { name: 'Open the lab record' });
    await expect(labLink).toBeVisible();
    await expect(labLink).toHaveAttribute('href', '/lab');
  });

  test('the Price score panel shows "No edge (measured)" and links to /signals', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const priceScorePanel = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Price score' }) });
    await expect(priceScorePanel.getByText('No edge (measured)')).toBeVisible();
    const scoreDetailLink = page.getByRole('link', { name: 'Score detail' });
    await expect(scoreDetailLink).toBeVisible();
    await expect(scoreDetailLink).toHaveAttribute('href', '/signals');
  });

  test('the chart shows past calls with a legend and a Show calls switch', async ({
    page,
  }) => {
    const trackRequest = page.waitForRequest((req) =>
      req.url().includes('/api/signals/track-record/bars')
    );
    await page.goto('/dashboard');
    await trackRequest;

    const switchBtn = page.getByRole('switch', { name: 'Show calls' });
    await expect(switchBtn).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Won after costs')).toBeVisible();

    await switchBtn.click();
    await expect(switchBtn).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Calls are hidden.')).toBeVisible();
  });

  test('choose the 1W interval and expect "Calls are not recorded at this interval."', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    await page.getByText('1W', { exact: true }).click();
    await expect(page.getByText('Calls are not recorded at this interval.')).toBeVisible();
  });

  test('the foot shows "Market data from Binance"', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const footLink = page.getByRole('link', { name: 'Market data from Binance' });
    await expect(footLink).toBeVisible();
    await expect(footLink).toHaveAttribute('href', 'https://www.binance.com/');
  });
});
