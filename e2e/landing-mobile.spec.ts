import { test, expect } from '@playwright/test';

const mockTickers = [
  { symbol: 'BTCUSDT', lastPrice: '65000.00', priceChangePercent: '-2.50' },
  { symbol: 'ETHUSDT', lastPrice: '3500.00', priceChangePercent: '1.20' },
  { symbol: 'SOLUSDT', lastPrice: '150.00', priceChangePercent: '4.80' },
];

test.use({ viewport: { width: 375, height: 667 } });

test.describe('Landing page (mobile viewport)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/prices', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockTickers),
      });
    });
  });

  test('Toggle menu button is visible, and desktop links are hidden', async ({ page }) => {
    await page.goto('/');
    const toggleButton = page.getByRole('button', { name: 'Toggle menu' });
    await expect(toggleButton).toBeVisible();

    const desktopNav = page.getByRole('navigation', { name: 'Main' });
    await expect(desktopNav).toBeHidden();
  });

  test('opening menu shows role="menu" with Log in and Create a free account', async ({ page }) => {
    await page.goto('/');
    const toggleButton = page.getByRole('button', { name: 'Toggle menu' });
    await toggleButton.click();

    const menu = page.getByRole('menu', { name: 'Navigation menu' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Log in', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Create a free account', exact: true })).toBeVisible();
  });

  test('Toggle menu button closes the menu', async ({ page }) => {
    await page.goto('/');
    const toggleButton = page.getByRole('button', { name: 'Toggle menu' });
    await toggleButton.click();

    const menu = page.getByRole('menu', { name: 'Navigation menu' });
    await expect(menu).toBeVisible();

    await toggleButton.click();
    await expect(menu).toBeHidden();
  });

  test('Escape closes menu and returns focus to the button', async ({ page }) => {
    await page.goto('/');
    const toggleButton = page.getByRole('button', { name: 'Toggle menu' });
    await toggleButton.click();

    const menu = page.getByRole('menu', { name: 'Navigation menu' });
    await expect(menu).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggleButton).toBeFocused();
  });

  test('choosing Features navigates to /features and closes menu', async ({ page }) => {
    await page.goto('/');
    const toggleButton = page.getByRole('button', { name: 'Toggle menu' });
    await toggleButton.click();

    const menu = page.getByRole('menu', { name: 'Navigation menu' });
    await expect(menu).toBeVisible();

    await menu.getByRole('menuitem', { name: 'Features', exact: true }).click();
    await expect(page).toHaveURL(/\/features/);
    await expect(menu).toBeHidden();
  });
});
