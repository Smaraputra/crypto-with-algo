import { test, expect } from '@playwright/test';

test.describe('Auth pages', () => {
  test('unauthenticated user visiting / redirects to /login', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page renders form and OAuth buttons', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Google' })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'GitHub' })
    ).toBeVisible();
  });

  test('register page renders form and OAuth buttons', async ({ page }) => {
    await page.goto('/register');

    await expect(page.getByLabel('Name')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Confirm Password')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create Account' })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Google' })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'GitHub' })
    ).toBeVisible();
  });

  test('login form shows error for bad credentials', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(
      page.getByText('Invalid email or password')
    ).toBeVisible();
  });

  test('navigation between login and register pages', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Sign up' }).click();
    await expect(page).toHaveURL(/\/register/);

    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
