import { test, expect } from '@playwright/test';

test.describe('Journal page (authenticated)', () => {
  test('journal page loads with tabs', async ({ page }) => {
    await page.goto('/journal');

    await expect(page.getByRole('heading', { name: 'Trading Journal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Entries' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Review Queue' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Playbook' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Analytics' })).toBeVisible();
  });

  test('entries tab shows filter bar and list', async ({ page }) => {
    await page.goto('/journal');

    // Filter bar should be visible in default entries tab
    await expect(page.getByTestId('journal-filter-bar')).toBeVisible({ timeout: 10000 });
  });

  test('review queue tab switches content', async ({ page }) => {
    await page.goto('/journal');

    await page.getByRole('tab', { name: 'Review Queue' }).click();
    // Review queue should show either entries or empty state
    const reviewContent = page.getByTestId('review-queue');
    const emptyState = page.getByText(/No entries to review/i);
    const hasReview = await reviewContent.count() > 0;
    const hasEmpty = await emptyState.count() > 0;
    expect(hasReview || hasEmpty).toBe(true);
  });

  test('playbook tab shows research notes view', async ({ page }) => {
    await page.goto('/journal');

    await page.getByRole('tab', { name: 'Playbook' }).click();
    await expect(page.getByTestId('playbook-view')).toBeVisible({ timeout: 10000 });
  });

  test('analytics tab shows analytics view', async ({ page }) => {
    await page.goto('/journal');

    await page.getByRole('tab', { name: 'Analytics' }).click();

    // Analytics should show either loaded content, loading, or error state
    const analyticsView = page.getByTestId('analytics-view');
    const analyticsLoading = page.getByTestId('analytics-loading');
    const analyticsError = page.getByTestId('analytics-error');

    // Wait for any of these to appear
    await expect(
      analyticsView.or(analyticsLoading).or(analyticsError)
    ).toBeVisible({ timeout: 10000 });
  });

  test('sidebar has journal link', async ({ page }) => {
    await page.goto('/dashboard');

    // The sidebar should contain a link to /journal
    const journalLinks = page.getByRole('link', { name: /journal/i });
    await expect(journalLinks.first()).toBeVisible({ timeout: 10000 });
  });
});
