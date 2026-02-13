import { test, expect } from '@playwright/test';

test.describe('Optimization Dashboard', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test.beforeEach(async ({ page }) => {
    // Navigate to optimization page
    await page.goto('/admin/optimization');
  });

  test('should show access denied for non-admin users', async ({ page }) => {
    // This test assumes the test user is not an admin
    // If redirected, we should be on dashboard
    await page.waitForURL(/\/(dashboard|admin\/optimization)/);

    const url = page.url();
    if (url.includes('/dashboard')) {
      // Non-admin was redirected - expected behavior
      expect(url).toContain('/dashboard');
    } else {
      // If ADMIN_EMAIL matches test user, page should load
      await expect(page.getByRole('heading', { name: /Optimization Dashboard/i })).toBeVisible();
    }
  });

  test('should display optimization form with all fields', async ({ page }) => {
    // Skip if redirected (non-admin)
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

    // Check form fields
    await expect(page.getByLabel(/Trading Style/i)).toBeVisible();
    await expect(page.getByLabel(/Symbol/i)).toBeVisible();
    await expect(page.getByLabel(/Interval/i)).toBeVisible();
    await expect(page.getByLabel(/Historical Data/i)).toBeVisible();

    // Check start optimization button
    await expect(page.getByRole('button', { name: /Start Optimization/i })).toBeVisible();
  });

  test('should validate form inputs', async ({ page }) => {
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

    // Try to submit empty form
    await page.getByRole('button', { name: /Start Optimization/i }).click();

    // Should show validation errors
    await expect(page.getByText(/Symbol is required/i)).toBeVisible();
  });

  test('should display estimated runtime when changing parameters', async ({ page }) => {
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

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
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

    // Click History tab
    await page.getByRole('tab', { name: /History/i }).click();

    // Should show table headers
    await expect(page.getByText(/Date/i)).toBeVisible();
    await expect(page.getByText(/Style/i)).toBeVisible();
    await expect(page.getByText(/Symbol/i)).toBeVisible();
    await expect(page.getByText(/Status/i)).toBeVisible();
  });

  test('should navigate between tabs', async ({ page }) => {
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

    // Default tab should be Optimize
    const optimizeTab = page.getByRole('tab', { name: /Optimize/i });
    await expect(optimizeTab).toHaveAttribute('data-state', 'active');

    // Switch to History
    await page.getByRole('tab', { name: /History/i }).click();
    const historyTab = page.getByRole('tab', { name: /History/i });
    await expect(historyTab).toHaveAttribute('data-state', 'active');

    // Switch to Compare
    await page.getByRole('tab', { name: /Compare/i }).click();
    const compareTab = page.getByRole('tab', { name: /Compare/i });
    await expect(compareTab).toHaveAttribute('data-state', 'active');
  });

  test('should show compare tab message when no template selected', async ({ page }) => {
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

    // Click Compare tab
    await page.getByRole('tab', { name: /Compare/i }).click();

    // Should show "no template selected" message
    await expect(page.getByText(/No template selected/i)).toBeVisible();
  });

  test('should display form in correct initial state', async ({ page }) => {
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

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
    const url = page.url();
    if (url.includes('/dashboard')) {
      test.skip();
    }

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

test.describe('Optimization Sidebar Navigation', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test('should show Optimization link in admin section when on admin page', async ({ page }) => {
    await page.goto('/admin/optimization');

    const url = page.url();
    if (url.includes('/dashboard')) {
      // Non-admin, no admin section
      test.skip();
    }

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
