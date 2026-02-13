import { test, expect } from '@playwright/test';

test.describe('Backtest page (authenticated)', () => {
  test('renders page heading and New Strategy button', async ({ page }) => {
    await page.goto('/backtest');
    await expect(page.getByRole('heading', { name: 'Backtest' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('New Strategy')).toBeVisible();
  });

  test('renders tab navigation with Configure, Results, History, Journal', async ({ page }) => {
    await page.goto('/backtest');
    await expect(page.getByRole('tab', { name: 'Configure' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('tab', { name: 'Results' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Journal' })).toBeVisible();
  });

  test('shows interval selector buttons', async ({ page }) => {
    await page.goto('/backtest');
    await expect(page.getByRole('tab', { name: 'Configure' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: '15m' })).toBeVisible();
    await expect(page.getByRole('button', { name: '1h' })).toBeVisible();
    await expect(page.getByRole('button', { name: '4h' })).toBeVisible();
    await expect(page.getByRole('button', { name: '1d' })).toBeVisible();
  });

  test('shows Run Backtest button', async ({ page }) => {
    await page.goto('/backtest');
    await expect(page.getByRole('button', { name: /Run Backtest/i })).toBeVisible({ timeout: 10000 });
  });

  test('History tab shows empty state', async ({ page }) => {
    await page.goto('/backtest');
    await page.getByRole('tab', { name: 'History' }).click();
    // Either shows empty state or has data
    const emptyState = page.getByTestId('history-empty');
    const historyTable = page.getByTestId('history-table');
    const hasEmpty = await emptyState.count() > 0;
    const hasTable = await historyTable.count() > 0;
    expect(hasEmpty || hasTable).toBe(true);
  });

  test('Journal tab shows link to journal page', async ({ page }) => {
    await page.goto('/backtest');
    await page.getByRole('tab', { name: 'Journal' }).click();
    await expect(page.getByText('The journal has moved to its own dedicated page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: 'Open Journal' })).toBeVisible();
  });

  test('New Strategy button opens form dialog', async ({ page }) => {
    await page.goto('/backtest');
    await page.getByRole('button', { name: 'New Strategy' }).click();
    // Dialog opens with a form containing Name label
    await expect(page.getByLabel('Name')).toBeVisible({ timeout: 5000 });
  });
});
