# Session 40 Handover - Audit Fix: Bugs, Weak Tests, Coverage Gaps

## Date
2026-02-14

## Summary
Implemented audit fix plan: fixed 3 code bugs, strengthened 5 areas of weak test assertions, and added 3 new test files for previously untested modules.

## Commits Made
1. `fix(audit): fix null assertion, silent errors, and registration race condition`
2. `test(audit): strengthen weak assertions in compute, scorer, and E2E tests`
3. `test(audit): add unit tests for walk-forward, template-versioning, and orchestrator`

## Changes

### Bug Fixes
- **BUG-1** (`monthly-orchestrator.ts:78`): Replaced `range.newest!` non-null assertion with explicit `!range.newest ||` null check. `getCandleRange()` can return `{ newest: null }`.
- **BUG-2** (`compute-engine.ts:222-234`): Added `console.error` logging and `result.computed -= insertFailures` / `result.errors += insertFailures` tracking when individual signal inserts fail after bulk insert failure.
- **BUG-3** (`register/route.ts:71-76`): Added `err.code === 11000` check to catch MongoDB duplicate key errors from concurrent duplicate email registration, returning 409 instead of 500.

### Strengthened Assertions
- `compute-for-style.test.ts:179-182`: Replaced `.toBeDefined()` with `.toBeGreaterThan(0)` for signal arrays + shape assertion on sample signal
- `compute-engine.test.ts:125-127`: Replaced `.toBeDefined()` with type/range/enum checks for score, tier, expiresAt
- `scorer.test.ts:59,247,276-277`: Replaced `.toBeDefined()` with tier enum validation, direction/strength checks
- `dashboard.spec.ts:56`: Removed `if (await addButton.isVisible())` conditional guard
- `signals.spec.ts:122-182`: Added clarifying comments to `.or()` chains (intentional for Binance 403)

### New Test Files
- `walk-forward.test.ts` (8 tests): Tests `calculateWindows` pure function (exported it)
- `template-versioning.test.ts` (7 tests): Tests version creation, activation, contributor marking
- `monthly-orchestrator.test.ts` (5 tests): Tests happy path, insufficient data, backfill, null regression

### Other
- Fixed unused variable `testDoc` in `walk-forward.ts` (lint warning)
- Removed unused imports `TradingStyle` and `mockCachedFetch` from `compute-engine.test.ts`

## Test Results
- **Unit tests**: 2071 passing (232 files), 0 failures (+27 new tests)
- **E2E tests**: 94 passing, 0 failures
- **TypeScript**: Clean
- **Lint**: 0 errors (13 pre-existing warnings across codebase)
- **Build**: Clean

## Remaining Uncommitted Files
There are still many uncommitted files from Phase 14 Enhanced Signal System (prior sessions). See git status for full list.
