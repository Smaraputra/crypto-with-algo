import { test, expect } from '@playwright/test';

test.describe('Lab record page (authenticated)', () => {
  test('renders the lab record heading, summary or notice, and price score record', async ({ page }) => {
    await page.goto('/lab');

    // Page heading
    await expect(page.getByRole('heading', { name: 'The lab record' })).toBeVisible({ timeout: 15000 });

    // Expect either the summary text "validated" or one of the StateNotice titles to be visible
    const validatedText = page.getByText(/validated/i).first();
    const loadingNotice = page.getByText('Loading the lab record.');
    const errorNotice = page.getByText('The lab record did not load.');
    const emptyNotice = page.getByText('No ideas are being tested right now.');

    await expect(
      validatedText.or(loadingNotice).or(errorNotice).or(emptyNotice).first()
    ).toBeVisible({ timeout: 15000 });

    // Price score and static V8_STATUS studies disclosure
    await expect(page.getByRole('heading', { name: 'Price score' })).toBeVisible();
    await expect(page.getByText('What was measured')).toBeVisible();
  });
});
