import { test, expect } from '@playwright/test';

/**
 * The admin optimization page.
 *
 * ADMIN_EMAIL is not set in the E2E environment, so the Playwright user is
 * never an admin and every admin-only test here skips. That was already true
 * and already reported as a skip -- these are the "admin-env-conditional
 * skips" in the suite's baseline -- but two things were wrong with how:
 *
 *   - the skips were bare `test.skip()` calls, so the report said a test was
 *     skipped without saying why, and the condition was re-derived by hand in
 *     each test from `page.url()`;
 *   - the only assertion that could ever run on the admin branch looked for a
 *     heading "Optimization Dashboard" while the page renders "Template
 *     Optimization", so the suite would have failed the first time anyone
 *     pointed ADMIN_EMAIL at the test user -- the one configuration that makes
 *     these tests worth having.
 *
 * Now the skips carry a reason, the heading matches the page, and the
 * non-admin path is asserted properly (redirected AND the admin heading
 * absent) rather than by a bare URL check. To run the admin tests, point
 * ADMIN_EMAIL at the Playwright test user.
 */
const ADMIN_ONLY = 'requires ADMIN_EMAIL to match the E2E test user';

test.describe('Optimization Dashboard', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test.beforeEach(async ({ page }) => {
    // Navigate to optimization page; non-admin users get redirected to /dashboard
    await page.goto('/admin/optimization', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/(admin\/optimization|dashboard)/, { timeout: 30000 });
  });

  test('redirects a non-admin away, or renders the page for an admin', async ({ page }) => {
    // Runs unconditionally: whichever branch is taken is a real assertion, so
    // this test cannot pass without having checked something.
    await page.waitForURL(/\/(dashboard|admin\/optimization)/);

    if (page.url().includes('/admin/optimization')) {
      await expect(page.getByRole('heading', { name: /Template Optimization/i })).toBeVisible();
    } else {
      expect(page.url()).toContain('/dashboard');
      await expect(page.getByRole('heading', { name: /Template Optimization/i })).toHaveCount(0);
    }
  });

  test('should display optimization form with all fields', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Check form fields
    await expect(page.getByLabel(/Trading Style/i)).toBeVisible();
    await expect(page.getByLabel(/Symbol/i)).toBeVisible();
    await expect(page.getByLabel(/Interval/i)).toBeVisible();
    await expect(page.getByLabel(/Historical Data/i)).toBeVisible();

    // Check start optimization button
    await expect(page.getByRole('button', { name: /Start Optimization/i })).toBeVisible();
  });

  test('should validate form inputs', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Try to submit empty form
    await page.getByRole('button', { name: /Start Optimization/i }).click();

    // Should show validation errors
    await expect(page.getByText(/Symbol is required/i)).toBeVisible();
  });

  test('should display estimated runtime when changing parameters', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Fill in symbol and interval
    await page.getByLabel(/Symbol/i).fill('BTCUSDT');
    await page.getByLabel(/Interval/i).click();
    await page.getByRole('option', { name: '1h' }).click();

    // Adjust months slider
    const slider = page.getByRole('slider');
    await slider.fill('6');

    // Should show estimated runtime
    await expect(page.getByText(/Estimated runtime/i)).toBeVisible();
  });

  test('should show history tab with table headers', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Click History tab
    await page.getByRole('tab', { name: /History/i }).click();

    // Should show table headers
    await expect(page.getByText(/Date/i)).toBeVisible();
    await expect(page.getByText(/Style/i)).toBeVisible();
    await expect(page.getByText(/Symbol/i)).toBeVisible();
    await expect(page.getByText(/Status/i)).toBeVisible();
  });

  test('should navigate between tabs', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Default tab should be Optimize
    const optimizeTab = page.getByRole('tab', { name: /Optimize/i });
    await expect(optimizeTab).toHaveAttribute('data-state', 'active');

    // Switch to History
    await page.getByRole('tab', { name: /History/i }).click();
    const historyTab = page.getByRole('tab', { name: /History/i });
    await expect(historyTab).toHaveAttribute('data-state', 'active');

    // Switch to Cron Runs
    await page.getByRole('tab', { name: /Cron Runs/i }).click();
    const cronTab = page.getByRole('tab', { name: /Cron Runs/i });
    await expect(cronTab).toHaveAttribute('data-state', 'active');

    // Switch to Compare
    await page.getByRole('tab', { name: /Compare/i }).click();
    const compareTab = page.getByRole('tab', { name: /Compare/i });
    await expect(compareTab).toHaveAttribute('data-state', 'active');
  });

  test('should show compare tab message when no template selected', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Click Compare tab
    await page.getByRole('tab', { name: /Compare/i }).click();

    // Should show "no template selected" message
    await expect(page.getByText(/No template selected/i)).toBeVisible();
  });

  test('should display form in correct initial state', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Trading style should default to day_trading
    const tradingStyleTrigger = page.getByRole('combobox', { name: /Trading Style/i });
    await expect(tradingStyleTrigger).toContainText(/Day Trading/i);

    // Symbol should be empty
    const symbolInput = page.getByLabel(/Symbol/i);
    await expect(symbolInput).toHaveValue('');

    // Interval should have a default
    const intervalTrigger = page.getByRole('combobox', { name: /Interval/i });
    await expect(intervalTrigger).toBeVisible();

    // Months slider should default to 6
    const slider = page.getByRole('slider');
    await expect(slider).toHaveValue('6');
  });

  test('should allow filling out the optimization form', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Select trading style
    await page.getByRole('combobox', { name: /Trading Style/i }).click();
    await page.getByRole('option', { name: /Swing Trading/i }).click();

    // Fill symbol
    await page.getByLabel(/Symbol/i).fill('ETHUSDT');

    // Select interval
    await page.getByRole('combobox', { name: /Interval/i }).click();
    await page.getByRole('option', { name: '4h' }).click();

    // Adjust months
    await page.getByRole('slider').fill('3');

    // Verify values
    await expect(page.getByRole('combobox', { name: /Trading Style/i })).toContainText(/Swing Trading/i);
    await expect(page.getByLabel(/Symbol/i)).toHaveValue('ETHUSDT');
    await expect(page.getByRole('combobox', { name: /Interval/i })).toContainText('4h');
    await expect(page.getByRole('slider')).toHaveValue('3');
  });
});

test.describe('Cron Runs Tab', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/optimization', { timeout: 30000 });
    // Wait for either the admin page or redirect to dashboard (non-admin)
    await page.waitForURL(/\/(admin\/optimization|dashboard)/, { timeout: 15000 });
  });

  test('should show Cron Runs tab', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    const cronTab = page.getByRole('tab', { name: /Cron Runs/i });
    await expect(cronTab).toBeVisible();
  });

  test('should show table headers or empty state in Cron Runs tab', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    await page.getByRole('tab', { name: /Cron Runs/i }).click();

    // Either table headers or empty state should appear
    const dateHeader = page.getByRole('columnheader', { name: /Date/i });
    const emptyState = page.getByText(/No cron runs yet/i);

    await expect(dateHeader.or(emptyState)).toBeVisible();
  });

  test('should show Trigger Optimization button in Cron tab', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    await page.getByRole('tab', { name: /Cron Runs/i }).click();

    await expect(page.getByRole('button', { name: /Trigger Optimization/i })).toBeVisible();
  });

  test('should open trigger dialog when button is clicked', async ({ page }) => {
    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    await page.getByRole('tab', { name: /Cron Runs/i }).click();
    await page.getByRole('button', { name: /Trigger Optimization/i }).click();

    await expect(page.getByRole('heading', { name: /Trigger Monthly Optimization/i })).toBeVisible();
    await expect(page.getByLabel(/Symbols/i)).toBeVisible();
    await expect(page.getByLabel(/Historical Data/i)).toBeVisible();
    await expect(page.getByLabel(/Auto-Activate/i)).toBeVisible();
  });
});

test.describe('Optimization Sidebar Navigation', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test('should show Optimization link in admin section when on admin page', async ({ page }) => {
    await page.goto('/admin/optimization');

    test.skip(!page.url().includes('/admin/optimization'), ADMIN_ONLY);

    // Should show Admin section header
    await expect(page.getByText('Admin')).toBeVisible();

    // Should show Optimization link
    const optimizationLink = page.getByRole('link', { name: /Optimization/i });
    await expect(optimizationLink).toBeVisible();
    await expect(optimizationLink).toHaveAttribute('href', '/admin/optimization');
  });

  test('should not show admin section on non-admin pages', async ({ page }) => {
    await page.goto('/dashboard');

    // Admin section should not be visible
    const adminSection = page.getByText('Admin').first();
    await expect(adminSection).not.toBeVisible();
  });
});
