import { test, expect } from '@playwright/test';
import { mockSymbols } from './helpers/live-data';

test.describe('Dashboard layout (authenticated)', () => {
  test('top bar shows product name link to /dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    const brandLink = page.getByRole('link', { name: 'CryptoWithAlgo' }).first();
    await expect(brandLink).toBeVisible();
    await expect(brandLink).toHaveAttribute('href', '/dashboard');
  });

  test('top bar shows navigation items', async ({ page }) => {
    await page.goto('/dashboard');
    const nav = page.getByRole('navigation', { name: 'Desktop primary' });
    await expect(nav.getByRole('link', { name: 'Market' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Lab' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Portfolio' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Journal' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Alerts' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Tools' })).toBeVisible();
  });

  test('dashboard page shows heading and welcome text', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(/Welcome/)).toBeVisible();
  });

  test('coin search palette toggle changes watchlist state for a coin', async ({ page }) => {
    await mockSymbols(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Search coins' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search coins' });
    await expect(dialog).toBeVisible();

    const toggleButton = dialog.getByRole('button', { name: /watchlist/i }).first();
    await expect(toggleButton).toBeVisible();
    const initialText = await toggleButton.innerText();
    await toggleButton.click();
    const expectedText = initialText.includes('Add')
      ? 'Remove from watchlist'
      : 'Add to watchlist';
    await expect(toggleButton).toHaveText(expectedText);
  });

  test('top bar Account menu shows Log out', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
  });
});
