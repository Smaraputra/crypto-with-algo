import { test, expect } from '@playwright/test';
import { mockSymbols } from './helpers/live-data';

test.describe('Portfolio (authenticated)', () => {
  test('top bar portfolio link navigates to /portfolio and shows heading and View control', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market', exact: true })).toBeVisible({ timeout: 15000 });

    const topBar = page.getByRole('navigation', { name: 'Desktop primary', exact: true });
    await topBar.getByRole('link', { name: 'Portfolio', exact: true }).click();

    await expect(page).toHaveURL('/portfolio', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible();

    // View control offers Holdings and Performance
    await expect(page.getByRole('radio', { name: 'Holdings', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Performance', exact: true })).toBeVisible();
  });

  test('empty state offers "New portfolio" when user has no portfolios', async ({ page }) => {
    await page.route('**/api/portfolio', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ portfolios: [] }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Create your first portfolio to track holdings.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New portfolio', exact: true })).toBeVisible();
  });

  test('create portfolio, add holding, record trade, remove holding, and delete portfolio', async ({ page }) => {
    // The coin picker lists /api/symbols, which Binance blocks from CI runners.
    await mockSymbols(page);
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible({ timeout: 15000 });

    const testPortfolioName = `E2E ${Date.now()}`;

    // Open "New portfolio" dialog
    const emptyNewBtn = page.getByRole('button', { name: 'New portfolio', exact: true });
    if (await emptyNewBtn.isVisible()) {
      await emptyNewBtn.click();
    } else {
      await page.getByRole('button', { name: 'Manage', exact: true }).click();
      await page.getByRole('menuitem', { name: 'New portfolio', exact: true }).click();
    }

    // Create portfolio dialog
    await expect(page.getByRole('heading', { name: 'New portfolio', exact: true })).toBeVisible();
    await page.getByLabel('Portfolio name', { exact: true }).fill(testPortfolioName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New portfolio', exact: true })).not.toBeVisible({ timeout: 10000 });

    const portfolioSelect = page.getByLabel('Portfolio', { exact: true });
    await expect(portfolioSelect.locator('option:checked')).toHaveText(testPortfolioName, { timeout: 10000 });

    try {
      // Add a holding through the "Add a holding" sheet (BNB, quantity 1, price 100)
      await page.getByRole('button', { name: 'Add a holding', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Add a holding', exact: true })).toBeVisible();

      // Searchable combobox: pick BNB by typing "BNB"
      await page.getByRole('combobox', { name: 'Coin', exact: true }).click();
      await page.getByPlaceholder('Search coin...').fill('BNB');
      await page.getByRole('option', { name: 'BNB', exact: true }).click();

      // Fill quantity and buy price
      await page.getByLabel('Quantity', { exact: true }).fill('1');
      await page.getByLabel('Buy price', { exact: true }).fill('100');

      await page.getByRole('button', { name: 'Save trade', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Add a holding', exact: true })).not.toBeVisible({ timeout: 10000 });

      // Confirm holding appears in table
      const bnbLink = page.getByRole('link', { name: 'BNB', exact: true }).first();
      await expect(bnbLink).toBeVisible({ timeout: 10000 });

      // "Record a trade" opens the sheet
      await page.getByRole('button', { name: 'Actions for BNB', exact: true }).first().click();
      await page.getByRole('menuitem', { name: 'Record a trade', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Record a trade', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Record a trade', exact: true })).not.toBeVisible();

      // Removing the holding asks for confirmation and removes it
      await page.getByRole('button', { name: 'Actions for BNB', exact: true }).first().click();
      await page.getByRole('menuitem', { name: 'Remove holding', exact: true }).click();

      const removeDialog = page.getByRole('dialog', { name: 'Remove holding' });
      await expect(removeDialog).toBeVisible();
      await expect(page.getByText('Are you sure you want to remove BNB from this portfolio?')).toBeVisible();

      await removeDialog.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(removeDialog).not.toBeVisible({ timeout: 10000 });
      await expect(bnbLink).not.toBeVisible();
    } finally {
      // Delete the test's own portfolio at the end, so the shared test user is left as found
      try {
        const isCurrent = await portfolioSelect.locator('option:checked').textContent().catch(() => null);
        if (isCurrent === testPortfolioName) {
          await page.getByRole('button', { name: 'Manage', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
          const deleteDialog = page.getByRole('dialog', { name: 'Delete portfolio' });
          await expect(deleteDialog).toBeVisible({ timeout: 5000 });
          await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
          await expect(deleteDialog).not.toBeVisible({ timeout: 10000 });
        }
      } catch {
        // Safe cleanup fallback
      }
    }
  });
});
