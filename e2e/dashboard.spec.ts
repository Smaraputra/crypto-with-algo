import { test, expect } from '@playwright/test';

test.describe('Dashboard features (authenticated)', () => {
  test('market overview section renders price cards or loading state', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    // MarketOverview renders either shimmer skeletons (loading) or price card buttons.
    // Binance REST may 403 from US IPs so we accept either state.
    const priceCards = page.getByRole('button').filter({ hasText: /USDT/ });
    const skeletons = page.locator('[class*="shimmer"]');

    // At least one of these should be present
    const hasPriceCards = await priceCards.count() > 0;
    const hasSkeletons = await skeletons.count() > 0;
    expect(hasPriceCards || hasSkeletons).toBe(true);
  });

  test('trading chart container renders', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    // The chart section should have interval selector tabs
    const chartSection = page.locator('[class*="space-y"]').filter({
      has: page.getByRole('tab'),
    });
    await expect(chartSection.first()).toBeVisible({ timeout: 10000 });
  });

  test('chart interval tabs are visible', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    // Check for at least some interval tabs
    await expect(page.getByRole('tab', { name: '1m' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('tab', { name: '1H' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '1D' })).toBeVisible();
  });

  test('watchlist shows default symbols', async ({ page }) => {
    await page.goto('/dashboard');

    // Default watchlist symbols are BTC, ETH, SOL (from Watchlist model defaults)
    // They display as "BTC", "ETH", "SOL" (with USDT stripped in the UI)
    await expect(page.getByText('BTC').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('ETH').first()).toBeVisible();
    await expect(page.getByText('SOL').first()).toBeVisible();
  });

  test('watchlist add button opens dropdown', async ({ page }) => {
    await page.goto('/dashboard');

    // Wait for watchlist to load
    await expect(page.getByText('Watchlist').first()).toBeVisible({ timeout: 10000 });

    // Click the add button (Plus icon button near Watchlist header)
    const watchlistSection = page.locator('div').filter({ hasText: /^Watchlist$/ }).first();
    const addButton = watchlistSection.locator('button').first();
    await expect(addButton).toBeVisible({ timeout: 5000 });
    await addButton.click();
    // Dropdown should show search input
    await expect(page.getByPlaceholder('Search symbol...')).toBeVisible();
  });

  test.describe('provisional signal score strip', () => {
    // Binance may be unreachable, so any status line is accepted. The strip text
    // itself comes from the scheduler-only scoring display, not from Binance.
    const STATUS =
      /Provisional|Awaiting|awaiting|Recorded|Waiting|Not enough history|Loading signal inputs|No recorded score|No scheduler score/;

    test('renders heading, legend, status and evidence at 1h', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

      const strip = page.getByTestId('signal-score-strip');
      await expect(strip).toBeVisible({ timeout: 20000 });
      await expect(strip.getByRole('heading', { name: 'Signal score · Day trading · 1h' })).toBeVisible();
      await expect(strip.getByText(/Filled bars are the scheduler/)).toBeVisible();
      await expect(strip.getByText(/never recorded/)).toBeVisible();
      await expect(strip.getByText(/^Measured record at 1h:/)).toBeVisible();
      await expect(strip.getByTestId('signal-score-status')).toHaveText(STATUS, { timeout: 20000 });
    });

    test('1d shows the Swing / Position toggle and Position changes the heading', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });
      await page.getByRole('tab', { name: '1D' }).click();

      const strip = page.getByTestId('signal-score-strip');
      await expect(strip.getByRole('heading', { name: /^Signal score · .* · 1d$/ })).toBeVisible({ timeout: 20000 });
      const toggle = strip.getByRole('group', { name: 'Trading style' });
      await expect(toggle).toBeVisible();
      await expect(toggle.getByRole('button', { name: 'Swing' })).toBeVisible();

      await toggle.getByRole('button', { name: 'Position' }).click();
      await expect(strip.getByRole('heading', { name: 'Signal score · Position · 1d' })).toBeVisible();
      await expect(toggle.getByRole('button', { name: 'Position' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('an unscored interval shows the no-score line and no toggle', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });
      await page.getByRole('button', { name: /^More$/ }).click();
      await page.getByRole('menuitem', { name: '3m' }).click();

      const strip = page.getByTestId('signal-score-strip');
      await expect(strip.getByTestId('signal-score-status')).toHaveText('No scheduler score for BTCUSDT at 3m.', {
        timeout: 20000,
      });
      await expect(strip.getByRole('group', { name: 'Trading style' })).toHaveCount(0);
    });
  });
});
