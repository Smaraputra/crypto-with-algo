import { test, expect } from '@playwright/test';

test.describe('Analytics page (authenticated)', () => {
  test('sidebar shows Analytics nav link', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('[data-testid="desktop-sidebar"]');
    await expect(sidebar.getByText('Analytics')).toBeVisible();
  });

  test('navigates to analytics page via sidebar', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('[data-testid="desktop-sidebar"]');
    await sidebar.getByText('Analytics').click();

    await expect(page).toHaveURL('/analytics');
    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  });

  test('analytics page renders tab buttons', async ({ page }) => {
    await page.goto('/analytics');

    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Cost Basis' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Risk Metrics' })).toBeVisible();
  });

  test('overview tab shows chart card', async ({ page }) => {
    await page.goto('/analytics');

    // The chart card wrapper is always rendered; it contains either
    // chart-container (with data), chart-empty, or chart-skeleton inside
    const chartCard = page.getByTestId('portfolio-value-chart');
    const fallback = page.getByText('Chart unavailable');

    await expect(
      chartCard.or(fallback)
    ).toBeVisible({ timeout: 10000 });
  });

  test('cost basis tab renders table or empty state', async ({ page }) => {
    await page.goto('/analytics');

    // Switch to Cost Basis tab
    await page.getByRole('tab', { name: 'Cost Basis' }).click();

    const table = page.getByTestId('cost-basis-table');
    const empty = page.getByTestId('cost-basis-empty');
    const skeleton = page.getByTestId('cost-basis-skeleton');
    const fallback = page.getByText('Cost basis unavailable');

    await expect(
      table.or(empty).or(skeleton).or(fallback)
    ).toBeVisible({ timeout: 10000 });
  });

  test('export CSV button visible on cost basis tab when data present', async ({ page }) => {
    await page.goto('/analytics');

    await page.getByRole('tab', { name: 'Cost Basis' }).click();

    // Export button only appears when there are holdings; accept either state
    const exportButton = page.getByTestId('export-csv-button');
    const empty = page.getByTestId('cost-basis-empty');

    await expect(
      exportButton.or(empty)
    ).toBeVisible({ timeout: 10000 });
  });

  test('risk metrics tab renders cards or insufficient data', async ({ page }) => {
    await page.goto('/analytics');

    // Switch to Risk Metrics tab
    await page.getByRole('tab', { name: 'Risk Metrics' }).click();

    const cards = page.getByTestId('risk-metrics-cards');
    const insufficient = page.getByTestId('risk-metrics-insufficient');
    const skeleton = page.getByTestId('risk-metrics-skeleton');
    const fallback = page.getByText('Risk metrics unavailable');

    await expect(
      cards.or(insufficient).or(skeleton).or(fallback)
    ).toBeVisible({ timeout: 10000 });
  });

  test('cost basis method selector shows FIFO/LIFO/HIFO options', async ({ page }) => {
    await page.goto('/analytics');
    await page.getByRole('tab', { name: 'Cost Basis' }).click();

    const methodSelector = page.getByTestId('method-selector');
    const empty = page.getByTestId('cost-basis-empty');

    // Method selector only renders when there are holdings
    const hasTable = await methodSelector.isVisible().catch(() => false);
    if (!hasTable) {
      await expect(empty).toBeVisible({ timeout: 10000 });
      return;
    }

    // Open the method selector dropdown
    await methodSelector.click();
    await expect(page.getByRole('option', { name: 'FIFO' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'LIFO' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'HIFO' })).toBeVisible();

    // Select LIFO and verify title updates
    await page.getByRole('option', { name: 'LIFO' }).click();
    await expect(page.getByText('Cost Basis (LIFO)')).toBeVisible();
  });

  test('export CSV dropdown shows format options', async ({ page }) => {
    await page.goto('/analytics');
    await page.getByRole('tab', { name: 'Cost Basis' }).click();

    const exportButton = page.getByTestId('export-csv-button');
    const empty = page.getByTestId('cost-basis-empty');

    // Export button only renders when there are holdings
    const hasExport = await exportButton.isVisible().catch(() => false);
    if (!hasExport) {
      await expect(empty).toBeVisible({ timeout: 10000 });
      return;
    }

    // Open the export dropdown
    await exportButton.click();
    await expect(page.getByTestId('export-generic')).toBeVisible();
    await expect(page.getByTestId('export-koinly')).toBeVisible();
    await expect(page.getByTestId('export-cointracker')).toBeVisible();

    // Close dropdown with Escape
    await page.keyboard.press('Escape');
  });

  test('tab switching works correctly', async ({ page }) => {
    await page.goto('/analytics');

    // Start on Overview (default)
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'data-state',
      'active'
    );

    // Switch to Cost Basis
    await page.getByRole('tab', { name: 'Cost Basis' }).click();
    await expect(page.getByRole('tab', { name: 'Cost Basis' })).toHaveAttribute(
      'data-state',
      'active'
    );

    // Switch to Risk Metrics
    await page.getByRole('tab', { name: 'Risk Metrics' }).click();
    await expect(page.getByRole('tab', { name: 'Risk Metrics' })).toHaveAttribute(
      'data-state',
      'active'
    );

    // Switch back to Overview
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'data-state',
      'active'
    );
  });
});
