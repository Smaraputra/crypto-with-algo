# Session 14 Handover

## Date
2026-02-08

## Step Completed
Step 13: Watchlist Backend

## What Was Done
- Created Watchlist Mongoose model with userId (unique, indexed) and symbols array (default: BTCUSDT, ETHUSDT, SOLUSDT)
- Created auth-protected CRUD API routes (GET/PUT /api/watchlist):
  - GET: returns user's watchlist symbols, auto-creates default on first access
  - PUT: Zod-validated update (string items with min(1), max 50 array), upserts with findOneAndUpdate
- Inline `auth()` session checks (not middleware-based) matching existing API route pattern
- Full test coverage for model and API routes

## Test Results
- 275 tests passing across 32 test files
- New tests: 5 (Watchlist model) + 10 (watchlist API routes) = 15 new tests
- Lint: zero errors
- TypeScript: zero type errors
- Build: clean production build

## Files Created
- `src/lib/models/watchlist.ts` -- Mongoose model
- `src/lib/models/watchlist.test.ts` -- 5 model tests (MongoMemoryServer)
- `src/app/api/watchlist/route.ts` -- GET/PUT handlers
- `src/app/api/watchlist/route.test.ts` -- 10 API route tests

## Files Modified
- `changelogs/CHANGELOG.md` -- updated [Unreleased]

## Key Decisions
- Ported reference implementation directly -- it was clean and followed existing patterns
- API uses inline `auth()` checks rather than middleware protection (middleware matcher already excludes /api routes)
- Empty symbols array is valid (allows clearing watchlist)
- Zod schema: `z.array(z.string().min(1)).max(50)` prevents empty strings but allows empty array

## Known Issues
- Docker services (MongoDB/Redis) required for E2E tests and auth flows
- Pre-existing `act()` warnings in `useWebSocket.test.ts`

## Next Step
Step 14: Watchlist UI (hook + sidebar component)
