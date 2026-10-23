import { test, expect } from '@playwright/test';

test.describe('Notes page (authenticated)', () => {
  test('visiting /research ends on /notes with Notes heading', async ({ page }) => {
    await page.goto('/research');
    await expect(page).toHaveURL(/\/notes/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test('creates a note with unique title, opens it in detail, edits it, and deletes it with confirmation', async ({
    page,
  }) => {
    const timestamp = Date.now();
    const initialTitle = `E2E Note ${timestamp}`;
    const updatedTitle = `E2E Note ${timestamp} (Updated)`;

    await page.goto('/notes');
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible({
      timeout: 15000,
    });

    // "New note" creates a note with a unique title
    await page.getByRole('button', { name: 'New note', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'New note', exact: true })).toBeVisible({
      timeout: 10000,
    });

    await page.getByLabel('Title', { exact: true }).fill(initialTitle);
    await page.getByLabel('Category', { exact: true }).selectOption('strategy');
    await page.getByLabel('Body', { exact: true }).fill('Initial note content for E2E verification.');

    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });

    try {
      // Appears in the list
      const noteListItem = page.getByRole('button', {
        name: `Open note: ${initialTitle}`,
        exact: true,
      });
      await expect(noteListItem).toBeVisible({ timeout: 10000 });

      // Opens in detail view
      const detail = page.getByTestId('note-detail');
      await expect(
        detail.getByRole('heading', { name: initialTitle, exact: true })
      ).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('note-body')).toContainText(
        'Initial note content for E2E verification.'
      );

      // Edit the note
      await detail.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edit note', exact: true })).toBeVisible({
        timeout: 10000,
      });

      await page.getByLabel('Title', { exact: true }).fill(updatedTitle);
      await page.getByLabel('Body', { exact: true }).fill('Updated note content for E2E verification.');

      await page.getByRole('button', { name: 'Save note', exact: true }).click();
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });

      // Detail reflects edited title and content
      await expect(
        detail.getByRole('heading', { name: updatedTitle, exact: true })
      ).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('note-body')).toContainText(
        'Updated note content for E2E verification.'
      );

      // Delete it with confirmation
      await detail.getByRole('button', { name: 'Delete', exact: true }).click();
      const deleteDialog = page.getByRole('dialog', { name: 'Delete note' });
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });

      await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(deleteDialog).not.toBeVisible({ timeout: 10000 });
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15000 });

      // Leaves test user as found: note no longer appears in list
      await expect(
        page.getByRole('button', { name: `Open note: ${updatedTitle}`, exact: true })
      ).toHaveCount(0, { timeout: 10000 });
    } catch (err) {
      // Safe fallback cleanup
      try {
        const detail = page.getByTestId('note-detail');
        if (await detail.isVisible()) {
          const deleteBtn = detail.getByRole('button', { name: 'Delete', exact: true });
          if (await deleteBtn.isVisible()) {
            await deleteBtn.click();
            const deleteDialog = page.getByRole('dialog', { name: 'Delete note' });
            if (await deleteDialog.isVisible()) {
              await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
            }
          }
        }
      } catch {
        // Safe cleanup fallback
      }
      throw err;
    }
  });
});
