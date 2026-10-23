import { test, expect } from '@playwright/test';

test.describe('Signals page (authenticated)', () => {
  test('navigates to signals page via Market score detail link', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('link', { name: 'Score detail' }).click();

    await expect(page).toHaveURL('/signals', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Price score', exact: true })).toBeVisible();
  });

  test('renders heading and "No edge (measured)" chip', async ({ page }) => {
    await page.goto('/signals');

    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No edge (measured)').first()).toBeVisible();
  });

  test('Style control changes the Interval options', async ({ page }) => {
    await page.goto('/signals');
    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });

    const styleGroup = page.getByRole('group', { name: 'Style' });
    const intervalGroup = page.getByRole('group', { name: 'Interval' });

    // Day trading (default) offers 15m and 1h
    await expect(intervalGroup.getByRole('radio', { name: '15m', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '1h', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '5m', exact: true })).toHaveCount(0);

    // Switching to Scalping offers 5m only
    await styleGroup.getByText('Scalping', { exact: true }).click();
    await expect(intervalGroup.getByRole('radio', { name: '5m', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '15m', exact: true })).toHaveCount(0);
    await expect(intervalGroup.getByRole('radio', { name: '1h', exact: true })).toHaveCount(0);

    // Switching to Position trading offers 1d only
    await styleGroup.getByText('Position trading', { exact: true }).click();
    await expect(intervalGroup.getByRole('radio', { name: '1d', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '5m', exact: true })).toHaveCount(0);

    // Switching to Swing trading offers 4h and 1d
    await styleGroup.getByText('Swing trading', { exact: true }).click();
    await expect(intervalGroup.getByRole('radio', { name: '4h', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '1d', exact: true })).toBeVisible();
  });

  test('has no text matching removed trade ticket or planning terms', async ({ page }) => {
    await page.goto('/signals');
    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });

    const forbidden = /entry|stop loss|take profit|position size|leverage/i;
    await expect(page.locator('body')).not.toHaveText(forbidden);
  });

  test('offers coin selector and renders score context sections', async ({ page }) => {
    await page.goto('/signals');
    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });

    // Coin select control
    const coinSelect = page.getByRole('combobox', { name: 'Coin' });
    await expect(coinSelect).toBeVisible();
    await expect(coinSelect).toHaveValue('BTCUSDT');

    // Recent readings panel
    await expect(page.getByRole('heading', { name: 'Recent readings' })).toBeVisible();

    // Futures context panel
    await expect(page.getByRole('heading', { name: 'Futures context' })).toBeVisible();

    // Link to lab record
    const labLink = page.getByRole('link', {
      name: 'See the full measured record on the lab page',
    });
    await expect(labLink).toBeVisible();
    await expect(labLink).toHaveAttribute('href', '/lab');
  });
});
