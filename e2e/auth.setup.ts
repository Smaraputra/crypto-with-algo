import { test as setup, expect } from '@playwright/test';

const TEST_USER = {
  name: 'E2E Test User',
  email: `e2e-${Date.now()}@test.local`,
  password: 'TestPassword123!',
};

setup('register and authenticate test user', async ({ page, baseURL }) => {
  // Register via API (idempotent -- 409 is fine if user exists from a previous partial run)
  const registerRes = await page.request.post(`${baseURL}/api/auth/register`, {
    data: {
      name: TEST_USER.name,
      email: TEST_USER.email,
      password: TEST_USER.password,
    },
  });
  expect([201, 409]).toContain(registerRes.status());

  // Log in via the UI to obtain a session cookie
  await page.goto('/login');
  await page.getByLabel('Email').fill(TEST_USER.email);
  await page.getByLabel('Password').fill(TEST_USER.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Wait for redirect to dashboard
  await expect(page).toHaveURL('/dashboard', { timeout: 10000 });

  // Verify we landed on the authenticated dashboard
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Save signed-in state for reuse by other test projects
  await page.context().storageState({ path: 'e2e/.auth/user.json' });
});
