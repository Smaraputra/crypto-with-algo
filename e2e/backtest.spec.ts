import { test, expect, type Page } from '@playwright/test';

async function stubCandles(page: Page) {
  await page.route('**/api/candles**', (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/candles/range' && method === 'GET') {
      return route.fulfill({
        status: 200,
        json: { oldest: null, newest: null, count: 0 },
      });
    }
    if (url.pathname === '/api/candles/backfill' && method === 'POST') {
      return route.fulfill({
        status: 200,
        json: { inserted: 120, total: 120, oldest: 1700000000000, newest: 1700432000000 },
      });
    }
    if (url.pathname === '/api/candles' && method === 'GET') {
      return route.fulfill({
        status: 200,
        json: { candles: [] },
      });
    }
    return route.continue();
  });
}

test.describe('Backtest page (authenticated)', () => {
  test('renders honest header with evidence chip and description', async ({ page }) => {
    await page.goto('/backtest');
    await expect(page.getByRole('heading', { name: 'Backtest', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('No edge (measured)')).toBeVisible();
    await expect(page.getByText(/lost after costs/)).toBeVisible();
  });

  test('renders controls and selectors', async ({ page }) => {
    await page.goto('/backtest');
    await expect(page.getByLabel('Strategy', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel('Coin', { exact: true })).toBeVisible();
    const intervalSelect = page.getByLabel('Interval', { exact: true });
    await expect(intervalSelect).toBeVisible();
    await expect(intervalSelect.locator('option')).toHaveText(['15m', '1h', '4h', '1d']);
    await expect(page.getByLabel('Data range', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run backtest' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Saved backtests' })).toBeVisible();
  });

  test('handles no stored history and offers candle download', async ({ page }) => {
    await stubCandles(page);
    await page.goto('/backtest');
    await expect(page.getByRole('button', { name: 'Run backtest' })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Run backtest' }).click();

    await expect(
      page.getByText('Insufficient candle data (0 bars). Try downloading history first.')
    ).toBeVisible({ timeout: 10000 });

    // Click the download button inside the insufficient history offer block (the second one on the page)
    await page.getByRole('button', { name: 'Download 24 months of history' }).last().click();

    await expect(page.getByText('Loaded 120 new bars (120 stored)')).toBeVisible({ timeout: 10000 });
  });

  test('creates a strategy with default weights and deletes it', async ({ page }) => {
    const strategyName = `E2E strategy ${Date.now()}`;
    await page.goto('/backtest');
    await expect(page.getByRole('heading', { name: 'Backtest', exact: true })).toBeVisible({ timeout: 10000 });

    try {
      await page.getByRole('button', { name: 'New strategy' }).click();
      const dialog = page.getByRole('dialog', { name: 'New strategy' });
      await expect(dialog).toBeVisible();

      await dialog.getByLabel('Strategy name').fill(strategyName);

      const btcCheckbox = dialog
        .getByRole('group', { name: 'Coins (1 to 5)' })
        .getByRole('checkbox', { name: 'BTC' });
      if (!(await btcCheckbox.isChecked())) {
        await btcCheckbox.check();
      }

      const oneHourCheckbox = dialog
        .getByRole('group', { name: 'Intervals (at least one)' })
        .getByRole('checkbox', { name: '1h' });
      if (!(await oneHourCheckbox.isChecked())) {
        await oneHourCheckbox.check();
      }

      await dialog.getByRole('button', { name: 'Create strategy' }).click();
      await expect(dialog).not.toBeVisible();

      const strategySelect = page.getByLabel('Strategy', { exact: true });
      await expect(strategySelect.locator('option:checked')).toHaveText(strategyName);

      const leftCol = page.getByTestId('left-column');
      await leftCol.getByRole('button', { name: 'Delete', exact: true }).click();
      // Confirm with the destructive Delete button that replaces it
      await leftCol.getByRole('button', { name: 'Delete', exact: true }).click();

      await expect(strategySelect).not.toContainText(strategyName);
    } finally {
      const res = await page.request.get('/api/strategies');
      if (res.ok()) {
        const data = (await res.json()) as { strategies?: Array<{ _id: string; name: string }> };
        for (const s of data.strategies ?? []) {
          if (s.name.startsWith('E2E strategy')) {
            await page.request.delete(`/api/strategies/${s._id}`);
          }
        }
      }
    }
  });
});
