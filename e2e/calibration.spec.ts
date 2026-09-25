import { test, expect } from '@playwright/test';

/**
 * The admin signal calibration page.
 *
 * ADMIN_EMAIL is not set in the E2E environment, so the Playwright user is
 * never an admin and the admin-branch tests here skip, the same arrangement
 * optimization.spec.ts uses and for the same reason. The first test runs
 * unconditionally and asserts whichever branch is actually taken, so a gate
 * regression on this route cannot pass unnoticed just because the environment
 * has no admin configured. To run the rest, point ADMIN_EMAIL at the test user.
 *
 * Nothing here asserts a number. The page reads the live SignalOutcome record,
 * which in a fresh E2E database is empty and in a synced one is whatever the
 * resolver has written, so any assertion on a value would be asserting the
 * state of production data rather than the behaviour of the page.
 */
const ADMIN_ONLY = 'requires ADMIN_EMAIL to match the E2E test user';

test.describe('Signal Calibration', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/calibration', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/(admin\/calibration|dashboard)/, { timeout: 30000 });
  });

  test('redirects a non-admin away, or renders the page for an admin', async ({ page }) => {
    await page.waitForURL(/\/(dashboard|admin\/calibration)/);

    if (page.url().includes('/admin/calibration')) {
      await expect(page.getByRole('heading', { name: /Signal Calibration/i })).toBeVisible();
    } else {
      expect(page.url()).toContain('/dashboard');
      await expect(page.getByRole('heading', { name: /Signal Calibration/i })).toHaveCount(0);
    }
  });

  test('states that the page is not a backtest', async ({ page }) => {
    test.skip(!page.url().includes('/admin/calibration'), ADMIN_ONLY);

    // The disclaimer is load-bearing, not decoration: these are close-to-close
    // forward returns with no stop, no take-profit and no fill simulation.
    await expect(page.getByText(/Not a backtest/i)).toBeVisible();
  });

  test('offers every filter and defaults to day trading at 1h', async ({ page }) => {
    test.skip(!page.url().includes('/admin/calibration'), ADMIN_ONLY);

    await expect(page.getByTestId('style-select')).toHaveValue('day_trading');
    await expect(page.getByTestId('interval-select')).toHaveValue('1h');
    await expect(page.getByTestId('source-select')).toHaveValue('composite');
    await expect(page.getByTestId('symbol-select')).toBeVisible();
    await expect(page.getByTestId('config-version-select')).toBeVisible();
  });

  test('resets the interval when the style does not score it', async ({ page }) => {
    test.skip(!page.url().includes('/admin/calibration'), ADMIN_ONLY);

    await page.getByTestId('style-select').selectOption('swing_trading');

    // swing_trading scores 4h and 1d, never 1h.
    await expect(page.getByTestId('interval-select')).toHaveValue('4h');
  });

  test('defaults the cumulative path to non-overlapping', async ({ page }) => {
    test.skip(!page.url().includes('/admin/calibration'), ADMIN_ONLY);

    await expect(page.getByTestId('overlapping-toggle')).toHaveText(/Non-overlapping/);
  });

  test('renders the coverage header once the record loads', async ({ page }) => {
    test.skip(!page.url().includes('/admin/calibration'), ADMIN_ONLY);

    await expect(page.getByTestId('coverage-header')).toBeVisible({ timeout: 30000 });
  });
});
