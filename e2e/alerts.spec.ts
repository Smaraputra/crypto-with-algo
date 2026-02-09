import { test, expect } from '@playwright/test';

test.describe('Alerts page (authenticated)', () => {
  test('navigates to alerts page via sidebar', async ({ page }) => {
    await page.goto('/dashboard');

    // Click Alerts in the sidebar navigation
    const sidebar = page.locator('[data-testid="desktop-sidebar"]');
    await sidebar.getByText('Alerts').click();

    await expect(page).toHaveURL('/alerts');
    await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
  });

  test('alerts page renders heading and create button', async ({ page }) => {
    await page.goto('/alerts');

    await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /create alert/i })
    ).toBeVisible();
  });

  test('filter tabs are visible', async ({ page }) => {
    await page.goto('/alerts');

    await expect(page.getByRole('tab', { name: 'All' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Active' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Triggered' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Paused' })).toBeVisible();
  });

  test('shows empty state or alert list', async ({ page }) => {
    await page.goto('/alerts');

    // Depending on test execution order, the user may have alerts from other tests.
    // Accept either the empty state or a populated alert list.
    const emptyState = page.getByText('No alerts yet');
    const alertList = page.getByTestId('alert-list');

    await expect(emptyState.or(alertList)).toBeVisible({ timeout: 10000 });
  });

  test('opens create alert dialog', async ({ page }) => {
    await page.goto('/alerts');

    await page.getByRole('button', { name: /create alert/i }).click();

    await expect(
      page.getByRole('heading', { name: 'Create Alert' })
    ).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Price Alert' })
    ).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Portfolio Alert' })
    ).toBeVisible();
  });

  test('creates a price alert and verifies it appears', async ({ page }) => {
    await page.goto('/alerts');

    // Open create dialog
    await page.getByRole('button', { name: /create alert/i }).click();
    await expect(
      page.getByRole('heading', { name: 'Create Alert' })
    ).toBeVisible();

    // Fill in price alert fields
    await page.getByLabel('Symbol').fill('BTCUSDT');
    await page.getByLabel('Target Price').fill('999999');

    // Submit
    await page.getByRole('button', { name: 'Create Alert' }).click();

    // Dialog should close and alert should appear in list
    await expect(page.getByText(/BTCUSDT price above/)).toBeVisible({
      timeout: 10000,
    });
    // Verify the alert item has an active badge
    const alertItem = page.locator('[data-testid^="alert-item-"]').first();
    await expect(alertItem.getByText('active')).toBeVisible();
  });

  test('pauses and resumes an alert', async ({ page }) => {
    await page.goto('/alerts');

    // Wait for the alert we created in the previous test (or any active alert)
    // If list is empty, create one first
    const hasAlerts = (await page.getByText(/BTCUSDT price above/).count()) > 0;
    if (!hasAlerts) {
      await page.getByRole('button', { name: /create alert/i }).click();
      await page.getByLabel('Symbol').fill('ETHUSDT');
      await page.getByLabel('Target Price').fill('888888');
      await page.getByRole('button', { name: 'Create Alert' }).click();
      await expect(page.getByText(/ETHUSDT price above/)).toBeVisible({
        timeout: 10000,
      });
    }

    // Click pause button
    const pauseButton = page.getByTitle('Pause').first();
    await expect(pauseButton).toBeVisible({ timeout: 5000 });
    await pauseButton.click();

    // Wait for the paused badge to appear anywhere in the alert list
    await expect(
      page.locator('[data-testid^="alert-item-"]').filter({ hasText: 'paused' })
    ).toHaveCount(1, { timeout: 10000 });

    // Click resume button
    const resumeButton = page.getByTitle('Resume').first();
    await expect(resumeButton).toBeVisible({ timeout: 5000 });
    await resumeButton.click();

    // Wait for the active badge to reappear (no more paused)
    await expect(
      page.locator('[data-testid^="alert-item-"]').filter({ hasText: 'paused' })
    ).toHaveCount(0, { timeout: 10000 });
  });

  test('deletes an alert', async ({ page }) => {
    await page.goto('/alerts');

    // Ensure there's at least one alert
    const hasAlerts =
      (await page.locator('[data-testid^="alert-item-"]').count()) > 0;
    if (!hasAlerts) {
      await page.getByRole('button', { name: /create alert/i }).click();
      await page.getByLabel('Symbol').fill('SOLUSDT');
      await page.getByLabel('Target Price').fill('777777');
      await page.getByRole('button', { name: 'Create Alert' }).click();
      await page.waitForTimeout(1000);
    }

    // Count alerts before delete
    const beforeCount = await page
      .locator('[data-testid^="alert-item-"]')
      .count();

    // Click delete button on first alert
    await page.getByTitle('Delete').first().click();

    // Confirm deletion in dialog
    await expect(page.getByText('Delete Alert')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();

    // Wait for alert to be removed
    await page.waitForTimeout(1000);
    const afterCount = await page
      .locator('[data-testid^="alert-item-"]')
      .count();

    expect(afterCount).toBeLessThan(beforeCount);
  });

  test('notification bell is visible in header', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(
      page.getByRole('button', { name: 'Notifications' })
    ).toBeVisible({ timeout: 10000 });
  });

  test('notification bell opens popover', async ({ page }) => {
    await page.goto('/dashboard');

    await page.getByRole('button', { name: 'Notifications' }).click();

    // Popover should show either notifications or empty state
    const hasNotifications =
      (await page.getByText('No new notifications').count()) > 0;
    const hasAlertItems =
      (await page.getByText('View All Alerts').count()) > 0;

    expect(hasNotifications || hasAlertItems).toBe(true);
  });
});
