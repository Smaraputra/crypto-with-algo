import { test, expect } from '@playwright/test';

test.describe('AppShell desktop (authenticated)', () => {
  test('primary links are visible with aria-current on Market, and Tools menu opens with Enter and closes with Escape', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    const nav = page.getByRole('navigation', { name: 'Desktop primary' });
    await expect(nav).toBeVisible();

    // The five primary links are visible
    const links = ['Market', 'Lab', 'Portfolio', 'Journal', 'Alerts'];
    for (const name of links) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }

    // aria-current="page" is on Market at /dashboard
    await expect(nav.getByRole('link', { name: 'Market' })).toHaveAttribute('aria-current', 'page');

    // Tools menu opens with Enter and closes with Escape
    const toolsButton = nav.getByRole('button', { name: 'Tools' });
    await toolsButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Cost Check' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Cost Check' })).not.toBeVisible();
  });

  test('Control+K opens the coin palette and Escape closes it', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search coins' });
    await expect(palette).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
  });
});

test.describe('AppShell phone (authenticated)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('bottom navigation shows 5 items, More sheet lists Alerts and Log out, and top bar links are hidden', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    // Top bar links are hidden
    await expect(page.getByRole('navigation', { name: 'Desktop primary' })).not.toBeVisible();

    // Bottom navigation (nav named "Main") shows Market, Lab, Portfolio, Journal and More
    const bottomNav = page.getByRole('navigation', { name: 'Main' });
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Market' })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Lab' })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Portfolio' })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Journal' })).toBeVisible();
    await expect(bottomNav.getByRole('button', { name: 'More' })).toBeVisible();

    // More opens a sheet titled "More" listing Alerts and Log out
    await bottomNav.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'More' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Alerts' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Log out' })).toBeVisible();

    // Escape closes the sheet
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
  });

  test('Control+K opens the coin palette and Escape closes it', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search coins' });
    await expect(palette).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
  });
});
