import { test, expect } from '@playwright/test';

test.describe('Analytics redirect and performance view (authenticated)', () => {
  test('visiting /analytics ends on /portfolio?tab=performance with Performance view selected', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page).toHaveURL(/\/portfolio\?tab=performance/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible();

    // Verify Performance view tab is active
    const performanceRadio = page.getByRole('radio', { name: 'Performance', exact: true });
    await expect(performanceRadio).toBeVisible();
    await expect(performanceRadio).toBeChecked();
  });

  test('Range and Method controls are present on performance view', async ({ page }) => {
    await page.goto('/portfolio?tab=performance');
    await expect(page.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible({ timeout: 15000 });

    // Range control
    const rangeGroup = page.getByRole('group', { name: 'Range', exact: true });
    await expect(rangeGroup).toBeVisible();
    await expect(page.getByRole('radio', { name: '7D', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: '30D', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: '90D', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: '1Y', exact: true })).toBeVisible();

    // Method control
    const methodGroup = page.getByRole('group', { name: 'Method', exact: true });
    await expect(methodGroup).toBeVisible();
    await expect(page.getByRole('radio', { name: 'FIFO', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'LIFO', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'HIFO', exact: true })).toBeVisible();
  });

  test('export control is present on performance view', async ({ page }) => {
    await page.goto('/portfolio?tab=performance');
    await expect(page.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible({ timeout: 15000 });

    // Export control
    await expect(page.getByLabel('Format', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV', exact: true })).toBeVisible();
  });
});
