import { test, expect } from '@playwright/test';

test.describe('Navigation feedback', () => {
  test('top bar link shows a pending indicator while the next page loads', async ({ page }) => {
    await page.goto('/dashboard');
    const nav = page.getByRole('navigation', { name: 'Desktop primary' });
    await expect(nav.getByRole('link', { name: 'Journal' })).toBeVisible({ timeout: 15000 });

    // Hold the Journal RSC payload so the navigation stays pending long enough to observe.
    await page.route('**/journal**', async (route) => {
      if (route.request().headers()['rsc']) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });

    const link = nav.getByRole('link', { name: 'Journal' });
    const indicator = link.getByTestId('nav-pending-indicator');
    await expect(indicator).not.toHaveAttribute('data-pending', 'true');

    await link.click();
    await expect(indicator).toHaveAttribute('data-pending', 'true', { timeout: 1000 });

    await expect(page).toHaveURL(/\/journal$/, { timeout: 15000 });
    await expect(indicator).not.toHaveAttribute('data-pending', 'true', { timeout: 5000 });
  });
});
