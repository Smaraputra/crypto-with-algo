import { test, expect } from '@playwright/test';

test.describe('Landing page (mobile viewport)', () => {
  test('hamburger menu is visible, desktop nav is hidden', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Toggle menu')).toBeVisible();
    // Desktop nav links should be hidden at mobile width
    const desktopNav = page.locator('.sm\\:flex').filter({ hasText: 'Sign In' });
    await expect(desktopNav).toBeHidden();
  });

  test('hamburger menu opens and shows nav links', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Toggle menu').click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Sign In')).toBeVisible();
    await expect(menu.getByText('Get Started')).toBeVisible();
  });

  test('hamburger menu closes on toggle', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Toggle menu').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByLabel('Toggle menu').click();
    await expect(page.getByRole('menu')).toBeHidden();
  });

  test('hamburger menu closes on Escape key', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Toggle menu').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
  });

  test('hero section renders at mobile width', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('hero-ticker')).toBeVisible();
  });

  test('features section is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Everything You Need')).toBeVisible();
  });

  test('how it works section is visible at mobile width', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible();
  });

  test('skip-to-content link is accessible', async ({ page }) => {
    await page.goto('/');
    // Tab to reveal the skip link
    await page.keyboard.press('Tab');
    const skipLink = page.getByText('Skip to content');
    await expect(skipLink).toBeVisible();
  });
});
