import { test, expect } from '@playwright/test';

test.describe('Email auth flows (unauthenticated)', () => {
  // Dev-mode compiles each API/page route on first hit, so allow extra headroom.
  test.describe.configure({ timeout: 90000 });

  test('registration shows the check-inbox screen', async ({ page }) => {
    await page.goto('/register');

    // Wait for the Turnstile widget to auto-pass (dummy key) and enable submit
    // BEFORE filling, so the widget's re-render doesn't race the submit.
    const submit = page.getByRole('button', { name: /create account/i });
    await expect(submit).toBeEnabled({ timeout: 30000 });

    const email = `e2e-reg-${Date.now()}@test.local`;
    await page.getByLabel('Name').fill('E2E Reg User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('RegTest123!');
    await page.getByLabel(/confirm/i).fill('RegTest123!');
    await page.getByRole('checkbox').check();

    await submit.click();

    // Generous timeout: the first POST to /api/auth/register compiles the route
    // on-demand in dev mode (mongoose, bcrypt, nodemailer), which can be slow.
    await expect(page.getByText(/check your inbox/i)).toBeVisible({ timeout: 45000 });
  });

  test('forgot-password shows a neutral confirmation', async ({ page }) => {
    await page.goto('/forgot-password');

    await page.getByLabel(/email/i).fill('whoever@test.local');
    await page.getByRole('button', { name: /send reset link/i }).click();

    await expect(page.getByText(/if an account exists/i)).toBeVisible({ timeout: 45000 });
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

    await expect(page.getByText(/verify your email/i)).toBeVisible({ timeout: 30000 });
  });
});
