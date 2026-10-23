import { test, expect } from '@playwright/test';
import { mockSymbols } from './helpers/live-data';

test.describe('Alerts page (authenticated)', () => {
  test('navigates to alerts page via top bar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    const topBar = page.getByRole('navigation', { name: 'Desktop primary' });
    await topBar.getByRole('link', { name: 'Alerts', exact: true }).click();

    await expect(page).toHaveURL('/alerts', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  });

  test('heading is Alerts and Show control works', async ({ page }) => {
    await page.goto('/alerts');

    await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible({
      timeout: 15000,
    });

    const showGroup = page.getByRole('group', { name: 'Show', exact: true });
    await expect(showGroup).toBeVisible();
    await expect(showGroup.getByRole('radio', { name: 'All', exact: true })).toBeVisible();
    await expect(showGroup.getByRole('radio', { name: 'Active', exact: true })).toBeVisible();
    await expect(showGroup.getByRole('radio', { name: 'Triggered', exact: true })).toBeVisible();
    await expect(showGroup.getByRole('radio', { name: 'Paused', exact: true })).toBeVisible();

    await showGroup.getByRole('radio', { name: 'Active', exact: true }).click();
    await expect(showGroup.getByRole('radio', { name: 'Active', exact: true })).toBeChecked();

    await showGroup.getByRole('radio', { name: 'All', exact: true }).click();
    await expect(showGroup.getByRole('radio', { name: 'All', exact: true })).toBeChecked();
  });

  test('creates a BNB price alert, pauses, resumes, and deletes it with confirmation', async ({
    page,
  }) => {
    await mockSymbols(page);

    await page.goto('/alerts');
    await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible({
      timeout: 15000,
    });

    // "New alert" opens the sheet
    await page.getByRole('button', { name: 'New alert', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'New alert', exact: true })).toBeVisible({
      timeout: 10000,
    });

    // Pick BNB via searchable combobox
    await page.getByRole('combobox', { name: 'Coin', exact: true }).click();
    await page.getByPlaceholder('Search coin...').fill('BNB');
    await page.getByRole('option', { name: 'BNB', exact: true }).click();

    // Fill target price
    await page.getByLabel('Target price', { exact: true }).fill('999999');

    // Create alert
    await page.getByRole('button', { name: 'Create alert', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New alert', exact: true })).not.toBeVisible({
      timeout: 10000,
    });

    await page.mouse.move(0, 0);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });

    const conditionText = 'BNB at or above $999,999';
    const table = page.getByRole('table');
    const alertRow = table.locator('tr').filter({ hasText: conditionText });

    try {
      // Appears in list with plain-language condition and active status
      await expect(alertRow).toBeVisible({ timeout: 10000 });
      await expect(alertRow.getByText('Active', { exact: true })).toBeVisible();

      // Pause changes its status to Paused
      await alertRow.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(alertRow.getByText('Paused', { exact: true })).toBeVisible({ timeout: 10000 });
      await expect(alertRow.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({
        timeout: 10000,
      });

      // Resume changes its status back to Active
      await alertRow.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(alertRow.getByText('Active', { exact: true })).toBeVisible({ timeout: 10000 });
      await expect(alertRow.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({
        timeout: 10000,
      });

      // Delete removes it after confirmation, leaving the test user as found
      await alertRow.getByRole('button', { name: 'Delete', exact: true }).click();
      const deleteDialog = page.getByRole('dialog', { name: 'Delete alert' });
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });

      await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(deleteDialog).not.toBeVisible({ timeout: 10000 });

      await expect(alertRow).toHaveCount(0, { timeout: 10000 });
    } catch (err) {
      // Fallback cleanup
      try {
        if (await alertRow.isVisible()) {
          await alertRow.getByRole('button', { name: 'Delete', exact: true }).click();
          const deleteDialog = page.getByRole('dialog', { name: 'Delete alert' });
          if (await deleteDialog.isVisible()) {
            await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
          }
        }
      } catch {
        // Safe cleanup fallback
      }
      throw err;
    }
  });

  test('notification bell is visible in header', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('button', { name: 'Alerts', exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test('notification bell opens popover', async ({ page }) => {
    await page.goto('/dashboard');

    await page.getByRole('button', { name: 'Alerts', exact: true }).click();

    // Popover should show triggered alerts section and All alerts link
    await expect(
      page.getByRole('dialog').getByText('Triggered alerts', { exact: true }).first()
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: 'All alerts', exact: true })).toBeVisible({
      timeout: 10000,
    });
  });
});
