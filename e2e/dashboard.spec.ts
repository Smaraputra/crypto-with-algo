import { test, expect } from '@playwright/test';

test.describe('Dashboard features (authenticated)', () => {
  test('market overview section renders price cards or loading state', async ({ page }) => {
    await page.goto('/dashboard');

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

    // The chart section should have interval selector tabs
    const chartSection = page.locator('[class*="space-y"]').filter({
      has: page.getByRole('tab'),
    });
    await expect(chartSection.first()).toBeVisible({ timeout: 10000 });
  });

  test('chart interval tabs are visible', async ({ page }) => {
    await page.goto('/dashboard');

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
});
