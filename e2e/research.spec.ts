import { test, expect } from '@playwright/test';

test.describe('Research page (authenticated)', () => {
  test('research page loads with heading', async ({ page }) => {
    await page.goto('/research');

    await expect(page.getByRole('heading', { name: 'Research Notes' })).toBeVisible({ timeout: 10000 });
  });

  test('research page shows playbook view', async ({ page }) => {
    await page.goto('/research');

    const view = page.getByTestId('playbook-view');
    const loading = page.getByTestId('playbook-loading');

    await expect(view.or(loading)).toBeVisible({ timeout: 10000 });
  });

  test('sidebar has research link', async ({ page }) => {
    await page.goto('/dashboard');

    const researchLinks = page.getByRole('link', { name: /research/i });
    await expect(researchLinks.first()).toBeVisible({ timeout: 10000 });
  });
});
