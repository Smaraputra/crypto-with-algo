import { test, expect } from '@playwright/test';

test.describe('Marketing Pages', () => {
  test('Docs page renders heading, nav, and footer', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { name: 'Documentation' })).toBeVisible();
    await expect(page.getByText('CryptoWithAlgo').first()).toBeVisible();
    await expect(page.getByText('Getting Started')).toBeVisible();
    await expect(page.getByText('Feature Reference')).toBeVisible();
  });

  test('Blog page renders heading and article cards', async ({ page }) => {
    await page.goto('/blog');
    await expect(page.getByRole('heading', { name: 'Blog' })).toBeVisible();
    await expect(page.getByText('Education')).toBeVisible();
    await expect(page.getByText('Strategy')).toBeVisible();
  });

  test('Features page renders heading and feature cards', async ({ page }) => {
    await page.goto('/features');
    await expect(page.getByRole('heading', { name: 'Features', level: 1 })).toBeVisible();
    await expect(page.getByText('Core Features')).toBeVisible();
    await expect(page.getByText('Portfolio Management')).toBeVisible();
    await expect(page.getByText('Trading Signals')).toBeVisible();
  });

  test('How It Works page renders heading and steps', async ({ page }) => {
    await page.goto('/how-it-works');
    await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible();
    await expect(page.getByText('Step 1')).toBeVisible();
    await expect(page.getByText('Step 2')).toBeVisible();
    await expect(page.getByText('Step 3')).toBeVisible();
  });

  test('Nav links navigate to correct pages', async ({ page }) => {
    await page.goto('/');
    // Click Features in the desktop nav
    await page.getByRole('link', { name: 'Features' }).first().click();
    await expect(page).toHaveURL(/\/features/);
    await expect(page.getByRole('heading', { name: 'Features', level: 1 })).toBeVisible();
  });

  test('Footer links navigate to correct pages', async ({ page }) => {
    await page.goto('/');
    // Scroll to footer and click How It Works link
    const howItWorksLink = page.getByRole('link', { name: 'How It Works' }).last();
    await howItWorksLink.scrollIntoViewIfNeeded();
    await howItWorksLink.click();
    await expect(page).toHaveURL(/\/how-it-works/);
  });
});
