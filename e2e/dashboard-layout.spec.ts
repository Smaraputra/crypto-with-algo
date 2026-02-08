import { test, expect } from '@playwright/test';

test.describe('Dashboard layout', () => {
  test('unauthenticated / redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  // The following tests require a signed-in user (Docker auth services needed).
  // They will be run in CI or locally with `docker-compose up -d`.

  test.describe('authenticated user', () => {
    test.skip(true, 'Requires Docker services for auth');

    test('dashboard shows header with Crypto Tracker', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Crypto Tracker')).toBeVisible();
    });

    test('sidebar shows navigation items', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Dashboard')).toBeVisible();
      await expect(page.getByText('Portfolio')).toBeVisible();
      await expect(page.getByText('Alerts')).toBeVisible();
    });

    test('dashboard page shows heading', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    });
  });
});
