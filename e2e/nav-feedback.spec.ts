import { test, expect } from '@playwright/test';

test.describe('Navigation feedback', () => {
  test('sidebar link shows a pending indicator while the next page loads', async ({ page }) => {
    await page.goto('/dashboard');
    const sidebar = page.getByTestId('desktop-sidebar');
    await expect(sidebar.getByRole('link', { name: 'Journal' })).toBeVisible({ timeout: 15000 });

    // Hold the Journal RSC payload so the navigation stays pending long enough to observe.
    await page.route('**/journal**', async (route) => {
      if (route.request().headers()['rsc']) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });

    const link = sidebar.getByRole('link', { name: 'Journal' });
    const indicator = link.getByTestId('nav-pending-indicator');
    await expect(indicator).toHaveAttribute('data-pending', 'false');

    await link.click();
    await expect(indicator).toHaveAttribute('data-pending', 'true', { timeout: 1000 });

    await expect(page).toHaveURL(/\/journal$/, { timeout: 15000 });
    await expect(indicator).toHaveAttribute('data-pending', 'false', { timeout: 5000 });
  });
});
