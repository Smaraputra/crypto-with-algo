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
    await expect(page.getByRole('heading', { name: 'Price score', exact: true })).toBeVisible();
    await expect(page.getByText('What was measured')).toBeVisible();
  });

  test('renders price score track record with Coin select and Timeframe control in loaded, loading, unavailable or error state', async ({
    page,
  }) => {
    await page.goto('/lab');

    await expect(
      page.getByRole('heading', { name: 'Price score track record' })
    ).toBeVisible({ timeout: 15000 });

    await expect(page.getByRole('combobox', { name: 'Coin' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Timeframe' })).toBeVisible();

    const loadedState = page.getByText(/Right \d+(\.\d+)?% of the time/);
    const loadingNotice = page.getByText('Loading the track record.');
    const unavailableNotice = page.getByText('No track record for this coin and timeframe.');
    const errorNotice = page.getByText('The track record did not load.');

    await expect(
      loadedState.or(loadingNotice).or(unavailableNotice).or(errorNotice).first()
    ).toBeVisible({ timeout: 15000 });
  });
});
