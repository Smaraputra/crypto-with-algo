import { test, expect } from '@playwright/test';

test.describe('Dashboard layout (authenticated)', () => {
  test('dashboard shows header with Crypto Tracker', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Crypto Tracker').first()).toBeVisible();
  });

  test('sidebar shows navigation items', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside');
    await expect(sidebar.getByText('Dashboard')).toBeVisible();
    await expect(sidebar.getByText('Portfolio')).toBeVisible();
    await expect(sidebar.getByText('Alerts')).toBeVisible();
    await expect(sidebar.getByText('Analytics')).toBeVisible();
  });

  test('dashboard page shows heading and welcome text', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(/Welcome/)).toBeVisible();
  });

  test('sidebar shows watchlist section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Watchlist').first()).toBeVisible();
  });

  test('header shows user dropdown', async ({ page }) => {
    await page.goto('/');
    // The user button should be visible (shows name or email)
    const userButton = page.locator('header').getByRole('button').filter({ has: page.locator('svg') }).last();
    await expect(userButton).toBeVisible();
  });
});
