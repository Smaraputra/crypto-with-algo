import { test, expect } from '@playwright/test';

test.describe('Alerts page (authenticated)', () => {
  test('navigates to alerts page via sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

    // Click Alerts in the sidebar navigation
    const sidebar = page.locator('[data-testid="desktop-sidebar"]');
    await sidebar.getByRole('link', { name: 'Alerts' }).click();

    await expect(page).toHaveURL('/alerts', { timeout: 10000 });
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
    // Verify this alert's item has an active badge. Scoped by its own text:
    // the authenticated project runs three workers against one user, so
    // sibling tests create, pause, and delete other alerts concurrently and
    // "the first item" is not stable.
    const alertItem = page
      .locator('[data-testid^="alert-item-"]')
      .filter({ hasText: 'BTCUSDT price above $999,999' })
      .first();
    await expect(alertItem.getByText('active')).toBeVisible();
  });

  test('pauses and resumes an alert', async ({ page, baseURL }) => {
    // Create alert via API for reliable setup (no dialog timing issues)
    const createRes = await page.request.post(`${baseURL}/api/alerts`, {
      data: {
        type: 'price_above',
        symbol: 'ETHUSDT',
        targetPrice: 888888,
      },
    });
    expect(createRes.ok()).toBe(true);
    const { alert } = await createRes.json();

    await page.goto('/alerts');
    await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible({ timeout: 15000 });

    // Scope every interaction to this test's own alert: sibling tests in
    // other workers create and delete alerts on the same user concurrently,
    // so "the first item" can change between the click and the assertion.
    const alertItem = page.getByTestId(`alert-item-${alert._id}`);
    await expect(alertItem).toBeVisible({ timeout: 15000 });

    // Pause this alert
    await alertItem.getByTitle('Pause').click();

    // Wait for UI to reflect paused state (PATCH + refetch + re-render)
    await expect(alertItem.getByTitle('Resume')).toBeVisible({ timeout: 15000 });

    // Resume the alert
    await alertItem.getByTitle('Resume').click();

    // Wait for UI to reflect active state again
    await expect(alertItem.getByTitle('Pause')).toBeVisible({ timeout: 15000 });
  });

  test('deletes an alert', async ({ page, baseURL }) => {
    // Create the alert this test deletes via API, so it never removes an
    // alert a sibling test in another worker is acting on
    const createRes = await page.request.post(`${baseURL}/api/alerts`, {
      data: {
        type: 'price_above',
        symbol: 'SOLUSDT',
        targetPrice: 777777,
      },
    });
    expect(createRes.ok()).toBe(true);
    const { alert } = await createRes.json();

    await page.goto('/alerts');
    await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible({ timeout: 15000 });

    const alertItem = page.getByTestId(`alert-item-${alert._id}`);
    await expect(alertItem).toBeVisible({ timeout: 15000 });

    // Click delete button on this alert
    await alertItem.getByTitle('Delete').click();

    // Confirm deletion in the visible dialog
    await expect(page.getByText('Are you sure you want to delete')).toBeVisible();
    // The AlertDialogAction is the only "Delete" button inside the visible dialog content
    await page
      .locator('[role="alertdialog"]')
      .filter({ hasText: 'Are you sure' })
      .getByRole('button', { name: 'Delete' })
      .click();

    // Wait for this alert item to be removed after React Query refetch
    await expect(alertItem).toHaveCount(0, { timeout: 15000 });
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
