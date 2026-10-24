import { test, expect } from '@playwright/test';

test.describe('Price score page (/signals/score)', () => {
  test('navigates to price score page via Market score detail link', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('link', { name: 'Score detail' }).click();

    await expect(page).toHaveURL('/signals/score', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Price score', exact: true })).toBeVisible();
  });

  test('renders heading and "No edge (measured)" chip', async ({ page }) => {
    await page.goto('/signals/score');

    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No edge (measured)').first()).toBeVisible();
  });

  test('Style control changes the Interval options', async ({ page }) => {
    await page.goto('/signals/score');
    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });

    const styleGroup = page.getByRole('group', { name: 'Style' });
    const intervalGroup = page.getByRole('group', { name: 'Interval' });

    // Day trading (default) offers 15m and 1h
    await expect(intervalGroup.getByRole('radio', { name: '15m', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '1h', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '5m', exact: true })).toHaveCount(0);

    // Switching to Scalping offers 5m only
    await styleGroup.getByText('Scalping', { exact: true }).click();
    await expect(intervalGroup.getByRole('radio', { name: '5m', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '15m', exact: true })).toHaveCount(0);
    await expect(intervalGroup.getByRole('radio', { name: '1h', exact: true })).toHaveCount(0);

    // Switching to Position trading offers 1d only
    await styleGroup.getByText('Position trading', { exact: true }).click();
    await expect(intervalGroup.getByRole('radio', { name: '1d', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '5m', exact: true })).toHaveCount(0);

    // Switching to Swing trading offers 4h and 1d
    await styleGroup.getByText('Swing trading', { exact: true }).click();
    await expect(intervalGroup.getByRole('radio', { name: '4h', exact: true })).toBeVisible();
    await expect(intervalGroup.getByRole('radio', { name: '1d', exact: true })).toBeVisible();
  });

  test('has no text matching removed trade ticket or planning terms', async ({ page }) => {
    await page.goto('/signals/score');
    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });

    const forbidden = /entry|stop loss|take profit|position size|leverage/i;
    await expect(page.locator('body')).not.toHaveText(forbidden);
  });

  test('offers coin selector and renders score context sections', async ({ page }) => {
    await page.goto('/signals/score');
    await expect(
      page.getByRole('heading', { name: 'Price score', exact: true })
    ).toBeVisible({ timeout: 15000 });

    // Coin select control
    const coinSelect = page.getByRole('combobox', { name: 'Coin' });
    await expect(coinSelect).toBeVisible();
    await expect(coinSelect).toHaveValue('BTCUSDT');

    // Recent readings panel
    await expect(page.getByRole('heading', { name: 'Recent readings' })).toBeVisible();

    // Futures context panel
    await expect(page.getByRole('heading', { name: 'Futures context' })).toBeVisible();

    // Link to lab record
    const labLink = page.getByRole('link', {
      name: 'See the full measured record on the lab page',
    });
    await expect(labLink).toBeVisible();
    await expect(labLink).toHaveAttribute('href', '/lab');
  });
});

test.describe('Signals and research hub (/signals)', () => {
  test('shows the heading "Signals and research" and "No rule is validated."', async ({ page }) => {
    await page.goto('/signals');
    await expect(
      page.getByRole('heading', { name: 'Signals and research', exact: true })
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No rule is validated.')).toBeVisible();
  });

  test('Status filter "Rejected" shows rv-v1 re-validation entry, expanding shows Steps and References', async ({
    page,
  }) => {
    await page.goto('/signals');
    await expect(
      page.getByRole('heading', { name: 'Signals and research', exact: true })
    ).toBeVisible({ timeout: 15000 });

    const statusGroup = page.getByRole('group', { name: 'Status' });
    await statusGroup.getByText('Rejected', { exact: true }).click();
    await expect(page).toHaveURL(/status=rejected/, { timeout: 10000 });

    const rvCard = page.locator('#rv-v1-revalidation');
    await expect(rvCard).toBeVisible();
    await expect(rvCard.getByRole('heading', { name: /rv-v1/i })).toBeVisible();

    // Expand the card
    await rvCard.getByRole('button').click();
    await expect(rvCard.getByRole('heading', { name: 'Steps' })).toBeVisible();
    await expect(rvCard.getByRole('heading', { name: 'References' })).toBeVisible();
  });

  test('expanded lab-v1 entry shows "Live state" and coin link leads to /focus?symbol=', async ({
    page,
  }) => {
    await page.goto('/signals');
    await expect(
      page.getByRole('heading', { name: 'Signals and research', exact: true })
    ).toBeVisible({ timeout: 15000 });

    const labCard = page.locator('#lab-v1');
    await expect(labCard).toBeVisible();

    // Expand the card
    const labButton = labCard.getByRole('button');
    if ((await labButton.getAttribute('aria-expanded')) !== 'true') {
      await labButton.click();
    }

    // Expanding it shows "Live state" (accept either live rows or the error line)
    await expect(labCard.getByRole('heading', { name: 'Live state' })).toBeVisible();
    await expect(
      labCard.locator('[data-testid="lab-hypothesis-row"], [role="alert"]')
    ).toBeVisible();

    // Coin link leads to /focus?symbol=
    const coinLink = labCard.getByRole('link', { name: 'BTC' }).first();
    await expect(coinLink).toBeVisible();
    await expect(coinLink).toHaveAttribute('href', /\/focus\?symbol=/);
  });
});
