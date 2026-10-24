import { test, expect } from '@playwright/test';

const mockTickers = [
  { symbol: 'BTCUSDT', lastPrice: '65000.00', priceChangePercent: '-2.50' },
  { symbol: 'ETHUSDT', lastPrice: '3500.00', priceChangePercent: '1.20' },
  { symbol: 'SOLUSDT', lastPrice: '150.00', priceChangePercent: '4.80' },
];

test.describe('Landing page (unauthenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/prices', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockTickers),
      });
    });
  });

  test('renders hero heading with exactly one h1', async ({ page }) => {
    await page.goto('/');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText('A crypto market tracker with an open research lab');
    await expect(h1).toBeVisible();
  });

  test('desktop bar shows navigation links, login, and registration links', async ({ page }) => {
    await page.goto('/');
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('link', { name: 'Features', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'How it works', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Blog', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Log in', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Create a free account', exact: true })).toBeVisible();
  });

  test('Log in link navigates to /login', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Log in', exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('Create a free account link navigates to /register', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Create a free account', exact: true }).first().click();
    await expect(page).toHaveURL(/\/register/);
  });

  test('price strip shows BTC ticker and negative change with minus sign', async ({ page }) => {
    await page.goto('/');
    const priceStrip = page.getByTestId('price-strip');
    await expect(priceStrip).toBeVisible();
    await expect(priceStrip).toContainText('BTC');
    await expect(priceStrip).toContainText('-2.50%');
  });

  test('lab section renders honest research copy without hype', async ({ page }) => {
    await page.goto('/');
    const labHeading = page.getByRole('heading', { name: 'Research in the open', exact: true });
    await expect(labHeading).toBeVisible();
    await expect(page.getByText('ideas that fail stay on the record')).toBeVisible();
    await expect(page.locator('body')).not.toHaveText(/public record|currently validated/i);
  });

  test('footer shows legal links', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Terms', exact: true })).toBeVisible();
  });

  test('theme switch toggles dark class on html element', async ({ page }) => {
    await page.goto('/');
    const themeSwitch = page.getByRole('banner').getByRole('switch', { name: 'Dark' }).first();
    await expect(themeSwitch).toBeVisible();

    // The starting theme depends on the default and the browser's colour scheme, so flip from whatever it is
    const html = page.locator('html');
    const startsDark = ((await html.getAttribute('class')) ?? '').split(/\s+/).includes('dark');

    await themeSwitch.click();
    if (startsDark) await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    else await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);

    await themeSwitch.click();
    if (startsDark) await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
  });
});
