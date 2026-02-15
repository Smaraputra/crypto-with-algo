import { test, expect } from '@playwright/test';

test.describe('Portfolio (authenticated)', () => {
  test('sidebar portfolio link navigates to /portfolio', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    // Click Portfolio in the desktop sidebar nav
    const sidebar = page.locator('[data-testid="desktop-sidebar"]');
    await sidebar.getByRole('link', { name: 'Portfolio' }).click();

    await expect(page).toHaveURL('/portfolio', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  });

  test('portfolio page renders heading and selector', async ({ page }) => {
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 10000 });

    // Portfolio selector trigger should be present
    const selectorTrigger = page.getByTestId('portfolio-selector-trigger');
    await expect(selectorTrigger).toBeVisible();
  });

  test('default portfolio "My Portfolio" is auto-created', async ({ page }) => {
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 10000 });

    // The selector trigger should show "My Portfolio"
    const selectorTrigger = page.getByTestId('portfolio-selector-trigger');
    await expect(selectorTrigger).toContainText('My Portfolio');
  });

  test('add holding button opens form dialog', async ({ page }) => {
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 10000 });

    const addBtn = page.getByTestId('add-holding-btn');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Dialog should show "Add Holding" title (use heading role to avoid matching the button text)
    await expect(page.getByRole('heading', { name: 'Add Holding' })).toBeVisible();
    // Form fields should be visible
    await expect(page.getByLabel('Symbol')).toBeVisible();
    await expect(page.getByLabel('Quantity')).toBeVisible();
    await expect(page.getByLabel('Price')).toBeVisible();
  });

  test('submit add holding form creates holding', async ({ page }) => {
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 10000 });

    // Open the form
    await page.getByTestId('add-holding-btn').click();
    await expect(page.getByRole('heading', { name: 'Add Holding' })).toBeVisible();

    // Fill in the form
    await page.getByLabel('Symbol').fill('BTCUSDT');
    await page.getByLabel('Base').fill('BTC');
    await page.getByLabel('Quantity').fill('0.1');
    await page.getByLabel('Price').fill('40000');

    // Submit -- use the dialog's submit button specifically
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.getByRole('button', { name: 'Add' }).click();

    // Wait for dialog to close and holding to appear in the table or cards
    await expect(page.getByRole('heading', { name: 'Add Holding' })).not.toBeVisible({ timeout: 10000 });

    // The holding should appear (either in table or card depending on viewport)
    await expect(page.getByText('BTC').first()).toBeVisible({ timeout: 10000 });
  });

  test('portfolio selector allows creating second portfolio', async ({ page }) => {
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 10000 });

    // Open the selector dropdown
    await page.getByTestId('portfolio-selector-trigger').click();

    // Click "Create New Portfolio"
    const createOption = page.getByText('Create New Portfolio');
    await expect(createOption).toBeVisible();
    await createOption.click();

    // Fill in the name and submit
    const nameInput = page.getByLabel('New portfolio name');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Trading');
    await page.getByRole('button', { name: 'Add' }).click();

    // Wait for the create form to disappear (mutation succeeded, onSuccess fired)
    await expect(page.getByLabel('New portfolio name')).not.toBeVisible({ timeout: 10000 });

    // Close the dropdown with Escape since the Radix overlay keeps intercepting clicks
    await page.keyboard.press('Escape');

    // Wait for dropdown to fully close
    await expect(page.getByText('Create New Portfolio')).not.toBeVisible({ timeout: 5000 });

    // Reopen to verify the new portfolio appears
    await page.getByTestId('portfolio-selector-trigger').click();
    await expect(page.getByText('Trading')).toBeVisible({ timeout: 5000 });
  });
});
