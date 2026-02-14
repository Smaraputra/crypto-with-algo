import { test, expect } from '@playwright/test';

test.describe('Journal page (authenticated)', () => {
  test('journal page loads with tabs', async ({ page }) => {
    await page.goto('/journal');

    await expect(page.getByRole('heading', { name: 'Trading Journal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Entries' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Open Trades' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Closed Trades' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Analytics' })).toBeVisible();
  });

  test('entries tab shows filter bar and export button', async ({ page }) => {
    await page.goto('/journal');

    await expect(page.getByTestId('journal-filter-bar')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('filter-trigger')).toBeVisible();
    await expect(page.getByTestId('export-csv-button')).toBeVisible();
  });

  test('new entry button is visible', async ({ page }) => {
    await page.goto('/journal');

    await expect(page.getByTestId('new-entry-button')).toBeVisible({ timeout: 10000 });
  });

  test('pnl summary strip is visible', async ({ page }) => {
    await page.goto('/journal');

    // Summary strip shows either loaded data or loading state
    const strip = page.getByTestId('pnl-summary-strip');
    const loading = page.getByTestId('pnl-strip-loading');

    await expect(strip.or(loading)).toBeVisible({ timeout: 10000 });
  });

  test('open trades tab switches content', async ({ page }) => {
    await page.goto('/journal');

    await page.getByRole('tab', { name: 'Open Trades' }).click();

    const list = page.getByTestId('open-trades-list');
    const loading = page.getByTestId('open-trades-loading');
    const empty = page.getByTestId('open-trades-empty');

    await expect(
      list.or(loading).or(empty)
    ).toBeVisible({ timeout: 10000 });
  });

  test('closed trades tab switches content', async ({ page }) => {
    await page.goto('/journal');

    await page.getByRole('tab', { name: 'Closed Trades' }).click();

    const list = page.getByTestId('closed-trades-list');
    const loading = page.getByTestId('closed-trades-loading');
    const empty = page.getByTestId('closed-trades-empty');

    await expect(
      list.or(loading).or(empty)
    ).toBeVisible({ timeout: 10000 });
  });

  test('analytics tab shows analytics view', async ({ page }) => {
    await page.goto('/journal');

    await page.getByRole('tab', { name: 'Analytics' }).click();

    const analyticsView = page.getByTestId('analytics-view');
    const analyticsLoading = page.getByTestId('analytics-loading');
    const analyticsError = page.getByTestId('analytics-error');

    await expect(
      analyticsView.or(analyticsLoading).or(analyticsError)
    ).toBeVisible({ timeout: 10000 });
  });

  test('sidebar has journal link', async ({ page }) => {
    await page.goto('/dashboard');

    const journalLinks = page.getByRole('link', { name: /journal/i });
    await expect(journalLinks.first()).toBeVisible({ timeout: 10000 });
  });
});
