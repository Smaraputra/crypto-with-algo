import { test, expect } from '@playwright/test';
import { mockHistory, mockStream, mockSymbols } from './helpers/live-data';

test.describe('Focus page (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await mockSymbols(page);
    await mockHistory(page);
  });

  test('navigates to focus page via coin search palette', async ({ page }) => {
    await mockStream(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Search coins' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search coins' });
    await expect(dialog).toBeVisible();
    await dialog.getByText('BTC', { exact: true }).click();

    await expect(page).toHaveURL('/focus?symbol=BTCUSDT', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'BTC study' })).toBeVisible({ timeout: 15000 });
  });

  test('renders page heading as "{BASE} study" for default and custom symbol', async ({ page }) => {
    await mockStream(page);
    await page.goto('/focus');
    await expect(page.getByRole('heading', { name: 'BTC study' })).toBeVisible({ timeout: 15000 });

    await page.goto('/focus?symbol=ETHUSDT');
    await expect(page.getByRole('heading', { name: 'ETH study' })).toBeVisible({ timeout: 15000 });
  });

  test('Interval control offers 15m, 1h, 4h and 1d, and changing it requests new kline stream on perp route', async ({
    page,
  }) => {
    const streamUrls = await mockStream(page);
    await page.goto('/focus');
    await expect(page.getByRole('heading', { name: 'BTC study' })).toBeVisible({ timeout: 15000 });

    const intervalGroup = page.getByRole('group', { name: 'Interval' });
    await expect(intervalGroup).toBeVisible();

    for (const label of ['15m', '1h', '4h', '1d']) {
      await expect(intervalGroup.getByRole('radio', { name: label })).toBeVisible();
    }
    await expect(intervalGroup.getByRole('radio', { name: '1h', exact: true })).toBeChecked();

    await intervalGroup.getByText('4h', { exact: true }).click();
    await expect(intervalGroup.getByRole('radio', { name: '4h', exact: true })).toBeChecked();

    await expect
      .poll(
        () =>
          streamUrls.some(
            (url) => url.includes('/api/stream/perp') && url.includes('btcusdt@kline_4h')
          ),
        { timeout: 10000 }
      )
      .toBe(true);
  });

  test('Structure, 50 SMA and MACD toggles flip aria-pressed', async ({ page }) => {
    await mockStream(page);
    await page.goto('/focus');
    await expect(page.getByRole('heading', { name: 'BTC study' })).toBeVisible({ timeout: 15000 });

    const structureBtn = page.getByRole('button', { name: 'Structure' });
    await expect(structureBtn).toHaveAttribute('aria-pressed', 'false');
    await structureBtn.click();
    await expect(structureBtn).toHaveAttribute('aria-pressed', 'true');
    await structureBtn.click();
    await expect(structureBtn).toHaveAttribute('aria-pressed', 'false');

    const smaBtn = page.getByRole('button', { name: '50 SMA' });
    await expect(smaBtn).toHaveAttribute('aria-pressed', 'false');
    await smaBtn.click();
    await expect(smaBtn).toHaveAttribute('aria-pressed', 'true');
    await smaBtn.click();
    await expect(smaBtn).toHaveAttribute('aria-pressed', 'false');

    const macdBtn = page.getByRole('button', { name: 'MACD' });
    await expect(macdBtn).toHaveAttribute('aria-pressed', 'false');
    await macdBtn.click();
    await expect(macdBtn).toHaveAttribute('aria-pressed', 'true');
    await macdBtn.click();
    await expect(macdBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('Draw disclosure reveals the drawing tools', async ({ page }) => {
    await mockStream(page);
    await page.goto('/focus');
    await expect(page.getByRole('heading', { name: 'BTC study' })).toBeVisible({ timeout: 15000 });

    const drawBtn = page.getByRole('button', { name: 'Draw', exact: true });
    await expect(drawBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('toolbar', { name: 'Drawing tools' })).not.toBeVisible();

    await drawBtn.click();
    await expect(drawBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('toolbar', { name: 'Drawing tools' })).toBeVisible();

    await drawBtn.click();
    await expect(drawBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('toolbar', { name: 'Drawing tools' })).not.toBeVisible();
  });

  test('Timeframes, Best evidence and cost panels render or show their states', async ({ page }) => {
    await mockStream(page);
    await page.goto('/focus');
    await expect(page.getByRole('heading', { name: 'BTC study' })).toBeVisible({ timeout: 15000 });

    // Timeframes panel
    await expect(page.getByRole('heading', { name: 'Timeframes' })).toBeVisible();

    // Best evidence panel
    await expect(page.getByRole('heading', { name: /Best evidence for BTC/ })).toBeVisible();

    // Cost panel
    await expect(page.getByRole('heading', { name: 'What a round trip costs' })).toBeVisible();

    // Chart container is visible
    await expect(page.getByTestId('chart-container')).toBeVisible({ timeout: 10000 });
  });

  test('"Open Cost Check" carries symbol and holdMinutes', async ({ page }) => {
    await mockStream(page);
    await page.goto('/focus?symbol=BTCUSDT');
    await expect(page.getByRole('heading', { name: 'BTC study' })).toBeVisible({ timeout: 15000 });

    const costCheckLink = page.getByRole('link', { name: 'Open Cost Check' });
    await expect(costCheckLink).toBeVisible();
    await expect(costCheckLink).toHaveAttribute(
      'href',
      '/cost-check?symbol=BTCUSDT&holdMinutes=60'
    );

    // Change hold to 4h (240 minutes) in CostPanel
    const holdGroup = page.getByRole('group', { name: 'Hold' });
    await expect(holdGroup).toBeVisible();
    await holdGroup.getByText('4h', { exact: true }).click();

    await expect(costCheckLink).toHaveAttribute(
      'href',
      '/cost-check?symbol=BTCUSDT&holdMinutes=240'
    );
  });
});
