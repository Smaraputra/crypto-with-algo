import { test, expect } from '@playwright/test';

test.describe('Email auth flows (unauthenticated)', () => {
  test('registration shows the check-inbox screen', async ({ page }) => {
    await page.goto('/register');

    const email = `e2e-reg-${Date.now()}@test.local`;
    await page.getByLabel('Name').fill('E2E Reg User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('RegTest123!');
    await page.getByLabel(/confirm/i).fill('RegTest123!');
    await page.getByLabel(/terms/i).check();

    // The dummy Turnstile site key auto-passes, enabling the submit button.
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page.getByText(/check your inbox/i)).toBeVisible({ timeout: 20000 });
  });

  test('forgot-password shows a neutral confirmation', async ({ page }) => {
    await page.goto('/forgot-password');

    await page.getByLabel(/email/i).fill('whoever@test.local');
    await page.getByRole('button', { name: /send reset link/i }).click();

    await expect(page.getByText(/if an account exists/i)).toBeVisible({ timeout: 20000 });
  });

  test('unverified user is blocked at login', async ({ page, baseURL }) => {
    const email = `e2e-unverified-${Date.now()}@test.local`;
    const password = 'Unverified123!';

    // Register via API: creates the user but does NOT verify the email.
    const res = await page.request.post(`${baseURL}/api/auth/register`, {
      data: {
        name: 'Unverified User',
        email,
        password,
        tosAccepted: true,
        turnstileToken: 'e2e-test-token',
      },
    });
    expect(res.status()).toBe(201);

    // Correct credentials, but the hard gate must block the unverified account.
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByText(/verify your email/i)).toBeVisible({ timeout: 15000 });
  });
});
