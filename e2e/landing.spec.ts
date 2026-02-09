import { test, expect } from '@playwright/test';

test.describe('Landing page (unauthenticated)', () => {
  test('landing page renders hero heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('nav has Sign In and Get Started links', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign In' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Get Started' }).first()).toBeVisible();
  });

  test('Sign In link navigates to /login', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign In' }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('Get Started link navigates to /register', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Get Started' }).first().click();
    await expect(page).toHaveURL(/\/register/);
  });

  test('features section is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Everything You Need')).toBeVisible();
  });

  test('how it works section is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible();
  });

  test('stats section is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('stats-grid')).toBeVisible();
  });

  test('CTA section is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Start Tracking Today')).toBeVisible();
  });

  test('footer is visible', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByText('AlgoCrypto', { exact: true })).toBeVisible();
  });
});
