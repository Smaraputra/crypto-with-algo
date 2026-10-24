import { test, expect } from '@playwright/test';

const mockTickers = [
  { symbol: 'BTCUSDT', lastPrice: '65000.00', priceChangePercent: '-2.50' },
  { symbol: 'ETHUSDT', lastPrice: '3500.00', priceChangePercent: '1.20' },
  { symbol: 'SOLUSDT', lastPrice: '150.00', priceChangePercent: '4.80' },
];

test.describe('Marketing Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/prices', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockTickers),
      });
    });
  });

  test('Features page renders h1, h2 sections, honest title, and compliant copy', async ({ page }) => {
    await page.goto('/features');
    await expect(page).toHaveTitle(/\| CryptoWithAlgo$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Features', exact: true })).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Market and coins', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Research', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Your trades', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Tools', exact: true })).toBeVisible();

    await expect(page.locator('body')).not.toHaveText(/guarantee|beat the market|win rate|tax/i);
  });

  test('How It Works page renders h1, five step headings, honest title, and compliant copy', async ({ page }) => {
    await page.goto('/how-it-works');
    await expect(page).toHaveTitle(/\| CryptoWithAlgo$/);
    await expect(page.getByRole('heading', { level: 1, name: 'How it works', exact: true })).toBeVisible();

    const stepHeadings = page.getByRole('heading', { level: 2 });
    await expect(stepHeadings).toHaveCount(5);
    await expect(page.getByRole('heading', { level: 2, name: /1\.\s*Create an account/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /2\.\s*Pick coins/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /3\.\s*Study a coin with its costs/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /4\.\s*Record trades and notes/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /5\.\s*Follow the lab's record/i })).toBeVisible();

    await expect(page.locator('body')).not.toHaveText(/guarantee|beat the market|win rate|tax/i);
  });

  test('Docs page renders h1, h2 sections, honest title, and compliant copy', async ({ page }) => {
    await page.goto('/docs');
    await expect(page).toHaveTitle(/\| CryptoWithAlgo$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Documentation', exact: true })).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Getting started', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Feature reference', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Data and limits', exact: true })).toBeVisible();

    await expect(page.locator('body')).not.toHaveText(/guarantee|beat the market|win rate|tax/i);
  });

  test('Blog page renders h1, h2 empty state, honest title, and compliant copy', async ({ page }) => {
    await page.goto('/blog');
    await expect(page).toHaveTitle(/\| CryptoWithAlgo$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Blog', exact: true })).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'No posts yet', exact: true })).toBeVisible();

    await expect(page.locator('body')).not.toHaveText(/guarantee|beat the market|win rate|tax/i);
  });

  test('Privacy Policy page renders h1, last updated date, honest title, and compliant copy', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page).toHaveTitle(/\| CryptoWithAlgo$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy', exact: true })).toBeVisible();
    await expect(page.getByText(/^Last updated: /)).toBeVisible();

    await expect(page.locator('body')).not.toHaveText(/guarantee|beat the market|win rate|tax/i);
  });

  test('Terms of Service page renders h1, last updated date, honest title, and compliant copy', async ({ page }) => {
    await page.goto('/terms');
    await expect(page).toHaveTitle(/\| CryptoWithAlgo$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service', exact: true })).toBeVisible();
    await expect(page.getByText(/^Last updated: /)).toBeVisible();

    await expect(page.locator('body')).not.toHaveText(/beat the market|win rate|tax/i);
  });
});
