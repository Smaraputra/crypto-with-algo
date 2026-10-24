import { test, expect } from '@playwright/test';
import { mockSymbols } from './helpers/live-data';

test.describe('Journal page (authenticated)', () => {
  test('journal page renders heading, View control with Trades and Stats, and Notes link', async ({
    page,
  }) => {
    await page.goto('/journal');

    await expect(page.getByRole('heading', { name: 'Journal', exact: true })).toBeVisible({
      timeout: 15000,
    });

    const viewGroup = page.getByRole('group', { name: 'View', exact: true });
    await expect(viewGroup).toBeVisible();
    await expect(viewGroup.getByRole('radio', { name: 'Trades', exact: true })).toBeVisible();
    await expect(viewGroup.getByRole('radio', { name: 'Stats', exact: true })).toBeVisible();

    const notesLink = page.getByRole('link', { name: 'Notes', exact: true });
    await expect(notesLink).toBeVisible();
    await expect(notesLink).toHaveAttribute('href', '/notes');

    const topBar = page.getByRole('navigation', { name: 'Desktop primary' });
    await expect(topBar.getByRole('link', { name: 'Journal', exact: true })).toBeVisible();
  });

  test('logs a trade, reviews it into closed trades, and deletes it with confirmation', async ({
    page,
  }) => {
    await mockSymbols(page);
    // A unique entry price keeps this attempt's row apart from any row a failed retry left behind
    const entryPrice = (200 + (Date.now() % 9000) / 100).toFixed(2);
    const tradeRow = page
      .getByRole('button', { name: 'Open trade entry for BNB', exact: true })
      .filter({ hasText: `$${entryPrice}` });

    await page.route('**/api/signals/latest*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          signal: {
            _id: 'sig-mock-bnb',
            symbol: 'BNBUSDT',
            interval: '1h',
            tradingStyle: 'day_trading',
            score: 55.4,
            tier: 'buy',
            confidence: 80,
            components: [],
            configVersion: 1,
            candleTimestamp: Date.now(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.goto('/journal');
    await expect(page.getByRole('heading', { name: 'Journal', exact: true })).toBeVisible({
      timeout: 15000,
    });

    // "Log a trade" opens the sheet
    await page.getByRole('button', { name: 'Log a trade', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Log a trade', exact: true })).toBeVisible({
      timeout: 10000,
    });

    // Pick BNB via searchable combobox
    await page.getByRole('combobox', { name: 'Coin', exact: true }).click();
    await page.getByPlaceholder('Search coin...').fill('BNB');
    await page.getByRole('option', { name: 'BNB', exact: true }).click();

    // Fill entry price
    await page.getByLabel('Entry price', { exact: true }).fill(entryPrice);

    // Submit trade
    await page.getByRole('button', { name: 'Save trade', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Log a trade', exact: true })).not.toBeVisible({
      timeout: 10000,
    });

    // Clear Sonner toast away from bottom-right controls
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });

    try {
      // Trade appears under "Open trades"
      await expect(page.getByRole('heading', { name: 'Open trades', exact: true })).toBeVisible({
        timeout: 10000,
      });
      await expect(tradeRow).toBeVisible({ timeout: 10000 });

      // Open trade to review it
      await tradeRow.click();
      await expect(page.getByRole('heading', { name: 'BNB Trade', exact: true })).toBeVisible({
        timeout: 10000,
      });

      // Review it: fill exit price and outcome P&L
      await page.getByLabel('Exit price', { exact: true }).fill('350');
      await page.getByLabel('Outcome P&L (%)', { exact: true }).fill('16.67');

      await page.getByRole('button', { name: 'Save review', exact: true }).click();
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });

      // Close the entry sheet
      // The footer Close comes before the sheet's corner X in the dialog
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
      await expect(page.getByRole('heading', { name: 'BNB Trade', exact: true })).not.toBeVisible({
        timeout: 10000,
      });

      // See it under "Closed trades"
      await expect(page.getByRole('heading', { name: 'Closed trades', exact: true })).toBeVisible({
        timeout: 10000,
      });
      const closedSection = page
        .locator('div', { has: page.getByRole('heading', { name: 'Closed trades', exact: true }) })
        .last();
      const closedTradeRow = closedSection
        .getByRole('button', { name: 'Open trade entry for BNB', exact: true })
        .filter({ hasText: `$${entryPrice}` });
      await expect(closedTradeRow).toBeVisible({ timeout: 10000 });

      // Assert the row is NOT in the Open trades section after the review
      const openSection = page
        .locator('div', { has: page.getByRole('heading', { name: 'Open trades', exact: true }) })
        .last();
      const openTradeRow = openSection
        .getByRole('button', { name: 'Open trade entry for BNB', exact: true })
        .filter({ hasText: `$${entryPrice}` });
      await expect(openTradeRow).toHaveCount(0);

      // Open closed trade and delete it with confirmation
      await closedTradeRow.click();
      await expect(page.getByRole('heading', { name: 'BNB Trade', exact: true })).toBeVisible({
        timeout: 10000,
      });

      // The entry sheet shows the hold time (the table has a Held column too, so scope to the sheet)
      await expect(page.getByRole('dialog').getByText('Held', { exact: true })).toBeVisible({ timeout: 10000 });

      await page.getByRole('button', { name: 'Delete trade', exact: true }).click();
      const deleteDialog = page.getByRole('dialog', { name: 'Delete trade' });
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });

      await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(deleteDialog).not.toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('heading', { name: 'BNB Trade', exact: true })).not.toBeVisible({
        timeout: 10000,
      });

      // Verify row is gone
      await expect(tradeRow).toHaveCount(0, { timeout: 10000 });
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });
    } catch (err) {
      // Fallback cleanup: ensure any open entry dialog is cleaned up if test failed midway
      try {
        const deleteBtn = page.getByRole('button', { name: 'Delete trade', exact: true });
        if (await deleteBtn.isVisible()) {
          await deleteBtn.click();
          const deleteDialog = page.getByRole('dialog', { name: 'Delete trade' });
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

  test('attaches a screenshot to a logged trade, views and removes it, then deletes the trade', async ({
    page,
  }) => {
    await mockSymbols(page);
    const entryPrice = (300 + (Date.now() % 9000) / 100).toFixed(2);
    const tradeRow = page
      .getByRole('button', { name: 'Open trade entry for BNB', exact: true })
      .filter({ hasText: `$${entryPrice}` });

    await page.route('**/api/signals/latest*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          signal: {
            _id: 'sig-mock-bnb-shot',
            symbol: 'BNBUSDT',
            interval: '1h',
            tradingStyle: 'day_trading',
            score: 55.4,
            tier: 'buy',
            confidence: 80,
            components: [],
            configVersion: 1,
            candleTimestamp: Date.now(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.goto('/journal');
    await expect(page.getByRole('heading', { name: 'Journal', exact: true })).toBeVisible({
      timeout: 15000,
    });

    // "Log a trade" opens the sheet
    await page.getByRole('button', { name: 'Log a trade', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Log a trade', exact: true })).toBeVisible({
      timeout: 10000,
    });

    // Pick BNB via searchable combobox
    await page.getByRole('combobox', { name: 'Coin', exact: true }).click();
    await page.getByPlaceholder('Search coin...').fill('BNB');
    await page.getByRole('option', { name: 'BNB', exact: true }).click();

    // Fill entry price
    await page.getByLabel('Entry price', { exact: true }).fill(entryPrice);

    // Set a PNG on the hidden input
    const pngBuffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(100),
    ]);
    await page.getByLabel('Screenshot files').setInputFiles({
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });

    // Save trade
    await page.getByRole('button', { name: 'Save trade', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Log a trade', exact: true })).not.toBeVisible({
      timeout: 10000,
    });

    await page.mouse.move(0, 0);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });

    try {
      // Trade appears under "Open trades"
      await expect(tradeRow).toBeVisible({ timeout: 10000 });

      // Open the row
      await tradeRow.click();
      await expect(page.getByRole('heading', { name: 'BNB Trade', exact: true })).toBeVisible({
        timeout: 10000,
      });

      // Expect getByRole('button', { name: 'View screenshot 1' }) and img whose src contains /api/journal/screenshots/
      const shotButton = page.getByRole('button', { name: 'View screenshot 1', exact: true });
      await expect(shotButton).toBeVisible({ timeout: 10000 });
      const shotImg = shotButton.locator('img');
      await expect(shotImg).toHaveAttribute('src', /\/api\/journal\/screenshots\//);

      // Open it
      await shotButton.click();
      const shotDialog = page.getByRole('dialog', { name: 'Screenshot 1' });
      await expect(shotDialog).toBeVisible({ timeout: 10000 });

      // Click "Remove screenshot"
      await shotDialog.getByRole('button', { name: 'Remove screenshot', exact: true }).click();

      // Confirm with "Remove"
      await shotDialog.getByRole('button', { name: 'Remove', exact: true }).click();

      // Expect the thumbnail gone
      await expect(page.getByRole('button', { name: 'View screenshot 1', exact: true })).toHaveCount(0, {
        timeout: 10000,
      });

      // Delete the trade
      await page.getByRole('button', { name: 'Delete trade', exact: true }).click();
      const deleteDialog = page.getByRole('dialog', { name: 'Delete trade' });
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });

      await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(deleteDialog).not.toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('heading', { name: 'BNB Trade', exact: true })).not.toBeVisible({
        timeout: 10000,
      });

      // Verify row is gone
      await expect(tradeRow).toHaveCount(0, { timeout: 10000 });
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });
    } catch (err) {
      // Safe cleanup fallback
      try {
        const deleteBtn = page.getByRole('button', { name: 'Delete trade', exact: true });
        if (await deleteBtn.isVisible()) {
          await deleteBtn.click();
          const deleteDialog = page.getByRole('dialog', { name: 'Delete trade' });
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

  test('?view=stats shows the Stats sections and the Kelly panel', async ({
    page,
  }) => {
    await page.goto('/journal?view=stats');

    await expect(page.getByRole('heading', { name: 'Journal', exact: true })).toBeVisible({
      timeout: 15000,
    });

    const emptyNotice = page.getByText('No stats available yet.');
    const kellyHeading = page.getByRole('heading', {
      name: 'Position size (Kelly)',
      exact: true,
    });
    await expect(emptyNotice.or(kellyHeading)).toBeVisible({ timeout: 10000 });
  });
});
