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

  test('Tools menu has Notes link', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('navigation', { name: 'Desktop primary' }).getByRole('button', { name: 'Tools' }).click();
    await expect(page.getByRole('menuitem', { name: 'Notes' })).toBeVisible({ timeout: 10000 });
  });
});
