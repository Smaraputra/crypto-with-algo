import { test, expect } from '@playwright/test';
import { mockSymbols } from './helpers/live-data';

test.describe('Focus page (authenticated)', () => {
  test('navigates to focus page via coin search palette', async ({ page }) => {
    await mockSymbols(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Search coins' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search coins' });
    await expect(dialog).toBeVisible();
    await dialog.getByText('BTC', { exact: true }).click();

    await expect(page).toHaveURL('/focus?symbol=BTCUSDT', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible();
  });

  test('renders heading, five rail headings, and chart container', async ({ page }) => {
    await page.goto('/focus');

    // Page heading
    await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible({ timeout: 15000 });

    // The five rail headings
    await expect(page.getByRole('heading', { name: 'Timeframes' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Best we have on this coin' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Signal score (v8)' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Round-trip cost' })).toBeVisible({ timeout: 10000 });
    // The hold buttons render in every state (data, loading or a venue error).
    await expect(page.getByRole('group', { name: 'Hold length' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Headlines' })).toBeVisible({ timeout: 10000 });

    // Chart container is visible; market data may be loaded or in error or loading state
    const chartContainer = page.locator('.h-\\[560px\\]');
    await expect(chartContainer).toBeVisible({ timeout: 10000 });
  });
});
