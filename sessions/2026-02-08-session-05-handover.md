# Session Handover: 2026-02-08 Session 05

## Step Completed
Step 4: Authentication Backend

## Summary
Added NextAuth.js v5 authentication with credentials and OAuth providers, user model, registration endpoint with rate limiting, and route-protecting middleware. Reference implementations from `_reference/` were used with bug fixes applied for testability, lazy DB initialization, rate limiter API, and JSON parsing safety.

## What Was Done

### User Model (`src/lib/models/user.ts`)
- Mongoose schema: name (required), email (required, unique), password (optional), image, emailVerified
- `timestamps: true` for automatic createdAt/updatedAt
- Hot-reload guard: `mongoose.models.User || mongoose.model()`

### Auth Config (`src/lib/auth.ts`)
- NextAuth v5 with JWT session strategy
- Providers: Credentials, Google, GitHub
- `loginSchema` and `authorizeCredentials()` exported as standalone functions for testability
- `MongoDBAdapter(getMongoClient)` -- passes function ref for lazy initialization (not eager call)
- JWT callback injects `user.id` into token; session callback injects `token.id` into `session.user`

### NextAuth Route Handler (`src/app/api/auth/[...nextauth]/route.ts`)
- Re-exports `GET` and `POST` from auth config handlers

### Registration Endpoint (`src/app/api/auth/register/route.ts`)
- Zod schema: name (2-100 chars), email (valid), password (6-100 chars)
- Module-level rate limiter via `createRateLimiter(5, '60 s')` factory pattern
- Try-catch on `req.json()` returns 400 for malformed JSON
- Checks duplicate email (409), hashes password with bcrypt (12 rounds), creates user (201)

### Middleware (`src/middleware.ts`)
- Cookie-only session check (avoids edge runtime `crypto` incompatibility)
- Checks both `authjs.session-token` and `__Secure-authjs.session-token`
- Public paths: `/login`, `/register`
- Redirects unauthenticated users to `/login?callbackUrl=...`
- Matcher excludes static assets and API routes

### Dependencies Added
- `zod` -- schema validation (was only transitive, now direct)
- `@auth/mongodb-adapter` -- NextAuth MongoDB adapter (installed with --legacy-peer-deps)
- `bcryptjs` -- password hashing (pure JS)
- `@types/bcryptjs` -- TypeScript types (dev)

### Tests (33 new, 98 total across 13 test files)
- `src/lib/models/user.test.ts` (6 tests) -- CRUD, unique constraint, timestamps, optional fields
- `src/lib/auth.test.ts` (13 tests) -- schema validation, authorize logic, JWT/session callbacks, strategy
- `src/app/api/auth/register/route.test.ts` (8 tests) -- JSON parsing, validation, duplicate, success, bcrypt, rate limit
- `src/middleware.test.ts` (6 tests) -- public paths, redirects, cookie checks

## Bugs Fixed from Reference Code
1. `auth.ts`: Inlined `authorize`/callbacks made untestable -- extracted `loginSchema` and `authorizeCredentials()` as exports
2. `auth.ts`: `MongoDBAdapter(getMongoClient())` eagerly calls async fn at import -- changed to `MongoDBAdapter(getMongoClient)` (adapter accepts function ref)
3. `register/route.ts`: `rateLimit(req, { maxRequests: 5, windowMs: 60_000 })` wrong API -- used factory `createRateLimiter(5, '60 s')` + `rateLimit(req, limiter)`
4. `register/route.ts`: No try-catch on `req.json()` -- added try-catch returning 400 on malformed JSON

## Verification Results
- `npm run lint` -- clean (0 errors, 0 warnings)
- `npm run typecheck` -- clean (0 type errors)
- `npm run test` -- 98/98 tests pass (13 test files)
- `npm run build` -- clean production build (middleware deprecation warning noted, still functional)

## Notes
- Next.js 16 shows "middleware file convention is deprecated, use proxy instead" warning during build. Middleware still works and is recognized as `Proxy (Middleware)` in build output. This is a soft deprecation; migration to `proxy.ts` can be done in a future step if needed.

## Next Step
Step 5: Auth pages (login + register UI) and E2E tests

## Files Changed

### Modified
- `package.json` / `package-lock.json` -- added zod, @auth/mongodb-adapter, bcryptjs, @types/bcryptjs
- `changelogs/CHANGELOG.md` -- Step 4 additions

### Created
- `src/lib/models/user.ts`
- `src/lib/models/user.test.ts`
- `src/lib/auth.ts`
- `src/lib/auth.test.ts`
- `src/app/api/auth/[...nextauth]/route.ts`
- `src/app/api/auth/register/route.ts`
- `src/app/api/auth/register/route.test.ts`
- `src/middleware.ts`
- `src/middleware.test.ts`
- `sessions/2026-02-08-session-05-handover.md`
