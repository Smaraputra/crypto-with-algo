# Session 29 Handover - Test Suite Audit Phase 1

**Date**: 2026-02-13
**Session Focus**: E2E Test Failures - Critical Fixes
**Status**: ✅ Phase 1 Complete

## Overview

Fixed all failing E2E tests (4 failures → 0 failures, 87/87 passing) as part of the Test Suite Audit and Expansion Plan. The failures were caused by viewport configuration issues and outdated test assertions that didn't match current component implementations.

## Changes Made

### 1. Playwright Configuration Updates (`playwright.config.ts`)

**Viewport Fix**:
- Added explicit desktop viewport (1280x720) for `unauthenticated` project
- Fixes landing page nav element visibility (Sign In/Get Started links use `hidden sm:flex` - only visible at 640px+ breakpoint)

**Port Change**:
- Changed dev server port from 3000 to 3300 to avoid conflicts
- Updated `baseURL` and `webServer.command` accordingly

**Test Isolation**:
- Added `landing.spec.ts` and `marketing-pages.spec.ts` to `testIgnore` for authenticated project
- These tests check unauthenticated behavior and were incorrectly running with authenticated sessions (causing redirects to /dashboard)

### 2. Journal E2E Test Fix (`e2e/journal.spec.ts`)

**Problem**: Review queue test was checking for content synchronously without waiting for loading state to complete

**Solution**:
- Added `waitForSelector` to wait for either `review-queue` or `review-queue-empty` testid
- Changed text search from regex to exact testid match for reliability
- Test now properly waits for data fetching before assertions

```typescript
// Before
const reviewContent = page.getByTestId('review-queue');
const emptyState = page.getByText(/No entries to review/i);

// After
await page.waitForSelector('[data-testid="review-queue"], [data-testid="review-queue-empty"]', { timeout: 10000 });
const reviewContent = page.getByTestId('review-queue');
const emptyState = page.getByTestId('review-queue-empty');
```

### 3. Backtest E2E Test Fix (`e2e/backtest.spec.ts`)

**Problem**: Test expected `JournalList` component in backtest Journal tab, but implementation changed in Phase 10

**Current Implementation**: Journal tab now shows a message directing users to the dedicated `/journal` page (lines 411-423 in `src/app/(dashboard)/backtest/page.tsx`)

**Solution**:
- Renamed test from "Journal tab shows journal list" to "Journal tab shows link to journal page"
- Updated assertions to check for redirect message and "Open Journal" link
- Reflects actual UI behavior after journal was moved to dedicated page

```typescript
// Before
test('Journal tab shows journal list', async ({ page }) => {
  await page.goto('/backtest');
  await page.getByRole('tab', { name: 'Journal' }).click();
  await expect(page.getByTestId('journal-list')).toBeVisible({ timeout: 10000 });
});

// After
test('Journal tab shows link to journal page', async ({ page }) => {
  await page.goto('/backtest');
  await page.getByRole('tab', { name: 'Journal' }).click();
  await expect(page.getByText('The journal has moved to its own dedicated page')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('link', { name: 'Open Journal' })).toBeVisible();
});
```

## Test Results

### Before
- Unit tests: ✅ 192 files, 1665 tests passing
- E2E tests: ❌ 83/87 passing (4 failures)
  - `landing.spec.ts` - Sign In link not visible (viewport issue)
  - `landing.spec.ts` - Get Started link not visible (viewport issue)
  - `journal.spec.ts` - Review queue content check failing (timing issue)
  - `backtest.spec.ts` - Journal tab JournalList not found (outdated test)

### After
- Unit tests: ✅ 192 files, 1665 tests passing
- E2E tests: ✅ 87/87 passing (0 failures)
- ESLint: ✅ 0 errors (6 warnings in test files - acceptable)
- TypeScript: ✅ No type errors
- Build: ✅ Clean production build

## Next Steps (Remaining Plan Phases)

### Phase 2: Audit Obsolete Unit Tests
- Search for tests referencing old component names/interfaces from pre-Phase 10
- Verify signal tests include sentiment scoring integration
- Check journal API tests validate new schema fields (tags, setup, signalId)
- Upgrade shallow tests to behavioral tests (click, type, state changes)
- Estimated: 5-10 tests to update

### Phase 3: Add Missing Unit Tests
- API routes: `src/app/api/candles/route.ts`, `src/app/api/candles/backfill/route.ts`
- Portfolio utility: `src/components/portfolio/holdings-columns.tsx` (optional)
- Estimated: 2-3 new test files, ~20-25 tests

### Phase 4: Expand E2E Coverage for Phase 7-12 Features
- Research notes workflow (create, edit, filter, pin) - `e2e/journal.spec.ts` expansion
- Journal analytics interactions (cards, charts, filters) - `e2e/journal.spec.ts` expansion
- Sentiment integration (gauge, news feed, signal breakdown) - `e2e/signals.spec.ts` expansion
- Backtest execution workflow (create strategy, run, view results) - `e2e/backtest.spec.ts` expansion
- Estimated: +20-23 new E2E tests

### Phase 5: Test Quality Improvements (Optional)
- Upgrade shallow rendering tests to behavioral tests
- Add interaction tests (click, type, submit)
- Add state change assertions
- Verify error case coverage
- Estimated: 10-20 tests improved

## Files Modified

| File | Changes | Lines |
|---|---|---|
| `playwright.config.ts` | Added desktop viewport, port change, test isolation | ~10 |
| `e2e/journal.spec.ts` | Added loading state wait | ~5 |
| `e2e/backtest.spec.ts` | Updated Journal tab test assertions | ~5 |
| `changelogs/CHANGELOG.md` | Added Phase 1 completion entry | ~7 |

## Validation

All project convention checks passing:

| |
|---|
| `npm run test` - ✅ 1665 tests passing<br>`npm run test:e2e` - ✅ 87 tests passing<br>`npm run lint` - ✅ 0 errors<br>`npm run typecheck` - ✅ No type errors<br>`npm run build` - ✅ Clean build |

## Commit

| |
|---|
| `2db8ad9` test(e2e): fix failing E2E tests with viewport and component updates |

## Notes

- The viewport issue was subtle - responsive nav elements using `hidden sm:flex` (Tailwind v4) only show at 640px+ breakpoint, but Playwright's default viewport for Chrome was smaller
- The backtest Journal tab change happened in Phase 10 when journal was moved to dedicated page - test was overlooked during that refactor
- Port 3300 chosen to avoid common dev server conflicts (3000 often in use)
- All fixes were configuration/test updates - no production code changes required

## Handover to Next Session

**Priority**: Continue with Phase 2 (Audit Obsolete Unit Tests) from Test Suite Audit Plan

**Key Questions**:
1. Do any signal/scorer tests need sentiment integration validation?
2. Do journal API tests check new Phase 10-12 schema fields?
3. Are there component tests still referencing old interfaces?

**References**:
- Test Suite Audit Plan: `plans/test-suite-audit-plan.md` (if created)
- Original plan context in session transcript
