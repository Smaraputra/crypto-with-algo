import { test, expect } from '@playwright/test';

test.describe('Auth pages (unauthenticated)', () => {
  test('unauthenticated user visiting / sees landing page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page).toHaveURL('/');
  });

  test('login page renders form and OAuth buttons', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'GitHub' })).toBeVisible();
  });

  test('register page redirects to login', async ({ page }) => {
    await page.goto('/register');
    await expect(page).toHaveURL(/\/login/);
    // Should show login form after redirect
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('login form shows error for bad credentials', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByText('Invalid email or password')).toBeVisible({ timeout: 15000 });
  });

  test('register then login flow', async ({ page, baseURL }) => {
    const email = `e2e-flow-${Date.now()}@test.local`;
    const password = 'FlowTestPass123!';

    // Register via API
    const res = await page.request.post(`${baseURL}/api/auth/register`, {
      data: { name: 'Flow Test', email, password },
    });
    expect(res.status()).toBe(201);

    // Login via UI
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Should redirect to dashboard
    await expect(page).toHaveURL('/dashboard', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
