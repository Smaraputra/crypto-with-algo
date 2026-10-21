import { test, expect } from '@playwright/test';

test.describe('Focus page (authenticated)', () => {
  test('navigates to focus page via sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const sidebar = page.locator('[data-testid="desktop-sidebar"]');
    await sidebar.getByRole('link', { name: 'Focus' }).click();

    await expect(page).toHaveURL(/\/focus/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible();
  });

  test('renders heading, four rail headings, and chart container', async ({ page }) => {
    await page.goto('/focus');

    // Page heading
    await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible({ timeout: 15000 });

    // The four rail headings
    await expect(page.getByRole('heading', { name: 'Timeframes' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Best we have on this coin' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Signal score (v8)' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Headlines' })).toBeVisible({ timeout: 10000 });

    // Chart container is visible; market data may be loaded or in error or loading state
    const chartContainer = page.locator('.h-\\[560px\\]');
    await expect(chartContainer).toBeVisible({ timeout: 10000 });
  });
});
