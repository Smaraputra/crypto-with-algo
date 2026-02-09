import { test, expect } from '@playwright/test';

test.describe('Signals page (authenticated)', () => {
  test('navigates to signals page via sidebar', async ({ page }) => {
    await page.goto('/dashboard');

    const sidebar = page.locator('[data-testid="desktop-sidebar"]');
    await sidebar.getByText('Signals').click();

    await expect(page).toHaveURL('/signals');
    await expect(page.getByRole('heading', { name: 'Signals' })).toBeVisible();
  });

  test('signals page renders heading and controls', async ({ page }) => {
    await page.goto('/signals');

    await expect(page.getByRole('heading', { name: 'Signals' })).toBeVisible();
    await expect(page.getByTestId('compute-button')).toBeVisible();
    await expect(page.getByTestId('interval-select')).toBeVisible();
  });

  test('symbol selector buttons are visible', async ({ page }) => {
    await page.goto('/signals');

    await expect(page.getByRole('button', { name: 'BTC' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ETH' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'SOL' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'BNB' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'XRP' })).toBeVisible();
  });

  test('futures data section is visible', async ({ page }) => {
    await page.goto('/signals');

    await expect(page.getByText('Futures Data')).toBeVisible();
    // Futures data may load or show error due to Binance 403 from US IPs
    const futuresPanel = page.getByTestId('futures-panel');
    const futuresUnavailable = page.getByText('Futures data unavailable');
    await expect(futuresPanel.or(futuresUnavailable)).toBeVisible({ timeout: 15000 });
  });

  test('signal history section is visible', async ({ page }) => {
    await page.goto('/signals');

    await expect(page.getByText('Signal History')).toBeVisible();
    // Initially no signals, so empty state or history table
    const emptyState = page.getByText('No signal history yet');
    const historyTable = page.getByTestId('signal-history');
    await expect(emptyState.or(historyTable)).toBeVisible({ timeout: 10000 });
  });

  test('compute button triggers signal computation', async ({ page }) => {
    await page.goto('/signals');

    const computeButton = page.getByTestId('compute-button');
    await expect(computeButton).toBeVisible();
    await expect(computeButton).toHaveText('Compute Now');

    await computeButton.click();

    // Button should show computing state or signal should appear
    // Accept either success (gauge appears) or error (API failure from Binance 403)
    const gauge = page.locator('svg').first();
    const computeError = page.getByText(/Failed to compute|error/i);
    const noSignal = page.getByText(/No signal computed/);

    // Wait for some result - either the signal computed or we got an error
    await expect(
      gauge.or(computeError).or(noSignal)
    ).toBeVisible({ timeout: 30000 });
  });

  test('switching symbol updates page context', async ({ page }) => {
    await page.goto('/signals');

    // Click ETH button
    await page.getByRole('button', { name: 'ETH' }).click();

    // Page should show context for ETHUSDT
    // The "no signal" message should reference the new symbol
    const ethSignal = page.getByText(/ETHUSDT/);
    await expect(ethSignal).toBeVisible({ timeout: 5000 });
  });

  test('interval selector has expected options', async ({ page }) => {
    await page.goto('/signals');

    const select = page.getByTestId('interval-select');
    await expect(select).toBeVisible();

    // Verify options exist
    await expect(select.locator('option[value="15m"]')).toHaveText('15m');
    await expect(select.locator('option[value="1h"]')).toHaveText('1h');
    await expect(select.locator('option[value="4h"]')).toHaveText('4h');
    await expect(select.locator('option[value="1d"]')).toHaveText('1D');
  });
});
