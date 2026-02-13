# Docker Deployment Plan

## Context

The app has no production Docker setup. The existing `docker-compose.yml` only runs MongoDB and Redis for local development. The goal is to make deployment from a private GitHub repo trivial: clone, configure env, `docker compose up -d`.

This plan containerizes everything: the Next.js app, MongoDB (with auth), Caddy (auto-HTTPS), and cron jobs -- all orchestrated via a single Docker Compose file.

## Architecture

```
                    Internet
                       |
                  [Caddy :443]
                  auto-HTTPS
                       |
                 [Next.js :3000]
                   standalone
                    /     \
           [MongoDB :27017]  [Upstash Redis]
            (containerized)   (external HTTP)
                       |
                 [Cron container]
              Alpine + crond + wget
```

Five containers + CI/CD:
- **app** -- Next.js standalone server
- **mongodb** -- MongoDB 7 with auth enabled
- **caddy** -- Reverse proxy with automatic Let's Encrypt HTTPS
- **cron** -- Alpine container hitting app cron endpoints on schedule

## Files to Create

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (deps, build, runner, seeder) |
| `docker-compose.prod.yml` | Production stack: app + mongodb + caddy + cron |
| `.dockerignore` | Exclude tests, docs, .git from build context |
| `docker/Caddyfile` | Caddy reverse proxy config |
| `docker/crontab.template` | Cron schedule for the 4 cron jobs |
| `docker/cron-entrypoint.sh` | Substitutes CRON_SECRET into crontab at startup |
| `docker/mongo-init.js` | Creates app database user on first MongoDB start |
| `src/app/api/health/route.ts` | Health check endpoint |
| `src/app/api/health/route.test.ts` | Unit test for health endpoint |
| `.env.production.example` | Documented production env template |
| `.github/workflows/deploy.yml` | Auto-deploy via SSH on push to main + manual dispatch |

## Files to Modify

| File | Change |
|------|--------|
| `next.config.ts` | Add `output: 'standalone'` |
| `.gitignore` | Add `!.env.production.example` to whitelist it |

## Implementation Details

### 1. next.config.ts -- Enable Standalone Output

Add `output: 'standalone'` to `nextConfig`. This produces a self-contained build in `.next/standalone/` with pruned `node_modules` (~60MB vs ~940MB full). Required for efficient Docker images.

```typescript
const nextConfig: NextConfig = {
  output: 'standalone',
  async headers() {
    // existing CSP headers unchanged
  },
};
```

### 2. Health Check Endpoint

**File**: `src/app/api/health/route.ts`

- `GET /api/health` -- returns JSON: status, timestamp, uptime, mongodb connection state
- Returns 200 when healthy, 503 when MongoDB is in error state
- Does NOT call `connectDB()` -- only checks `mongoose.connection.readyState`
- Middleware matcher already excludes `/api` paths (`src/middleware.ts:44`), so no auth needed
- `dynamic = 'force-dynamic'` to prevent Next.js from caching the route

### 3. Dockerfile -- Multi-Stage Build

Four stages:

**Stage 1: deps** -- Install dependencies
- Base: `node:22-alpine` (Node 22 LTS, not 24 which isn't LTS yet)
- Copy `package.json` + `package-lock.json` first for layer caching
- `npm ci --legacy-peer-deps` (required for `@auth/mongodb-adapter` peer dep mismatch)

**Stage 2: builder** -- Build the app
- Copy source code and `node_modules` from deps stage
- Pass `NEXT_PUBLIC_BINANCE_WS_URL` as build arg (baked into client JS by Next.js at build time)
- Run `npm run build` producing standalone output

**Stage 3: runner** -- Production image
- Fresh `node:22-alpine` with non-root user (`nextjs:nodejs`)
- Copy only: `.next/standalone/`, `.next/static/`, `public/`
- Entrypoint: `node server.js`
- Estimated image size: ~230-250MB

**Stage 4: seeder** -- Optional target for seed script
- Uses deps stage `node_modules` + full source
- Entrypoint: `npx tsx scripts/seed.ts`
- Not part of the default build -- only built when explicitly targeted

### 4. docker-compose.prod.yml

**app service**:
- Builds from Dockerfile
- Port 3000 internal only (Caddy fronts it)
- `env_file: .env.production`
- Healthcheck: `wget --spider -q http://localhost:3000/api/health`
- Depends on mongodb (healthy)
- Restart: unless-stopped

**mongodb service**:
- Image: `mongo:7`
- Auth enabled: `MONGO_INITDB_ROOT_USERNAME` + `MONGO_INITDB_ROOT_PASSWORD` from env file
- Init script (`docker/mongo-init.js`) creates app user with `readWrite` role on `cryptowithalgo` db
- Data persisted in named volume `mongodb_prod_data`
- No port binding -- only accessible within Docker network
- Healthcheck: `mongosh --eval "db.adminCommand('ping')"`

**caddy service**:
- Image: `caddy:2-alpine`
- Ports 80 + 443 exposed
- Auto-provisions Let's Encrypt TLS certificates
- Reverse proxies to `app:3000`
- Config via `docker/Caddyfile`
- Volumes: `caddy_data` (certs), `caddy_config`

**cron service**:
- Image: `alpine:3.20` (~7MB)
- Runs `crond` executing `wget` to hit app cron endpoints
- `cron-entrypoint.sh` substitutes `CRON_SECRET` into crontab at startup (Alpine crond doesn't pass env vars to jobs)
- Depends on app (healthy)
- Restart: unless-stopped

### 5. Cron Schedule

| Job | Schedule | Endpoint |
|-----|----------|----------|
| Check alerts | Every 5 min | `/api/cron/check-alerts` |
| Sync candles | Every 15 min | `/api/cron/sync-candles` |
| Compute signals | Every 10 min | `/api/cron/compute-signals` |
| Portfolio snapshots | Daily midnight UTC | `/api/cron/snapshot-portfolios` |

All endpoints use `Authorization: Bearer $CRON_SECRET` header.

`docker/crontab.template`:
```
*/5  * * * * wget -qO- --header="Authorization: Bearer ${CRON_SECRET}" http://app:3000/api/cron/check-alerts
*/15 * * * * wget -qO- --header="Authorization: Bearer ${CRON_SECRET}" http://app:3000/api/cron/sync-candles
*/10 * * * * wget -qO- --header="Authorization: Bearer ${CRON_SECRET}" http://app:3000/api/cron/compute-signals
0    0 * * * wget -qO- --header="Authorization: Bearer ${CRON_SECRET}" http://app:3000/api/cron/snapshot-portfolios
```

### 6. MongoDB Init Script

`docker/mongo-init.js` runs on first container start:
- Connects as root admin
- Switches to `cryptowithalgo` database
- Creates app user with `readWrite` role
- The `MONGODB_URI` in `.env.production` uses this app user

### 7. Caddy Configuration

`docker/Caddyfile`:
```
{$DOMAIN:localhost} {
    reverse_proxy app:3000
}
```

Domain set via `DOMAIN` env var in `.env.production`. Caddy auto-handles HTTPS when a real domain is configured.

### 8. Seeder

The seed script (`scripts/seed.ts`) uses `@/` path aliases and `tsx`, which don't work in the standalone image. Solution: a separate `seeder` build target.

```bash
# Build seeder image
docker build --target seeder -t crypto-seeder .

# Run seed against production MongoDB
docker run --rm --network cryptowithalgo_default \
  --env-file .env.production \
  crypto-seeder
```

### 9. Environment Management

**`.env.production.example`** -- documented template with all variables:

| Variable | Required | Build/Runtime | Notes |
|----------|----------|---------------|-------|
| `MONGODB_URI` | Yes | Runtime | Connection string with app user credentials |
| `UPSTASH_REDIS_REST_URL` | Recommended | Runtime | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Recommended | Runtime | Upstash auth token |
| `NEXTAUTH_SECRET` | Yes | Runtime | Generate: `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Yes | Runtime | `https://yourdomain.com` |
| `GOOGLE_CLIENT_ID` | No | Runtime | Google OAuth (optional) |
| `GOOGLE_CLIENT_SECRET` | No | Runtime | Google OAuth (optional) |
| `GITHUB_CLIENT_ID` | No | Runtime | GitHub OAuth (optional) |
| `GITHUB_CLIENT_SECRET` | No | Runtime | GitHub OAuth (optional) |
| `BINANCE_API_URL` | No | Runtime | Defaults to `https://api.binance.com/api/v3` |
| `NEXT_PUBLIC_BINANCE_WS_URL` | No | **Build-time** | Defaults to `wss://stream.binance.com:9443` |
| `BINANCE_FUTURES_API_URL` | No | Runtime | Defaults to `https://fapi.binance.com` |
| `CRON_SECRET` | Yes | Runtime | Generate: `openssl rand -hex 32` |
| `MONGO_ROOT_USERNAME` | Yes | Runtime | MongoDB root admin username |
| `MONGO_ROOT_PASSWORD` | Yes | Runtime | MongoDB root admin password |
| `MONGO_APP_USERNAME` | Yes | Runtime | MongoDB app user (used in MONGODB_URI) |
| `MONGO_APP_PASSWORD` | Yes | Runtime | MongoDB app user password |
| `DOMAIN` | Yes | Runtime | Your domain for Caddy HTTPS |

**Build-time vs. runtime**: Only `NEXT_PUBLIC_BINANCE_WS_URL` is baked at build time. All other variables are read via `process.env` at request time and work via `env_file` in compose.

### 10. .dockerignore

Excludes: `node_modules`, `.next`, `.git`, `_reference`, `coverage`, test-results, playwright files, E2E tests, test files (`*.test.ts`), fixtures, mocks, test utilities, docs, changelogs, sessions, plans, CLAUDE.md, dev configs.

Keeps build context at ~3-4MB vs ~1.6GB unfiltered.

### 11. Database Migrations

No explicit migration system needed. MongoDB is schema-flexible and Mongoose models define indexes via schema decorators. Indexes are created automatically when models are first used (`autoIndex: true` by default). The `connectDB()` singleton in `src/lib/mongodb.ts` handles connection pooling.

For the 10 models with compound/unique indexes (User, Portfolio, Watchlist, Alert, PortfolioSnapshot, Candle, Signal, Strategy, JournalEntry, ResearchNote, BacktestResult), Mongoose's auto-index is sufficient for single-server deployment.

### 12. Auto-Deploy -- `.github/workflows/deploy.yml`

GitHub Actions workflow that deploys to the VPS via SSH after CI passes.

**Triggers**:
- Automatic on push to `main` (waits for CI workflow to succeed first)
- Manual via `workflow_dispatch` button in GitHub Actions UI

**Flow**:
1. CI workflow runs (lint, typecheck, tests, build, E2E)
2. If CI passes, deploy workflow triggers
3. SSHs into VPS using deploy key stored as GitHub secret
4. Runs: `cd /opt/cryptowithalgo && git pull && docker compose -f docker-compose.prod.yml up -d --build`
5. Verifies health endpoint returns 200

**GitHub Secrets required** (repo Settings > Secrets and variables > Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | VPS IP address or hostname |
| `VPS_USER` | SSH user on VPS (e.g. `deploy`) |
| `VPS_SSH_KEY` | Private SSH key for the deploy user |
| `VPS_PORT` | SSH port (default 22) |

**Workflow**:
```yaml
name: Deploy
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: >
      github.event_name == 'workflow_dispatch' ||
      github.event.workflow_run.conclusion == 'success'
    steps:
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          port: ${{ secrets.VPS_PORT }}
          script: |
            cd /opt/cryptowithalgo
            git pull origin main
            docker compose -f docker-compose.prod.yml up -d --build
            sleep 10
            curl -sf http://localhost:3000/api/health || exit 1
            echo "Deploy successful"
```

Uses `appleboy/ssh-action` -- a well-maintained GitHub Action for SSH commands (7k+ stars, used widely).

## Deployment Workflow

### Initial VPS Setup (one-time)

```bash
# On VPS as root:
adduser deploy
usermod -aG docker deploy

# As deploy user:
git clone git@github.com:user/cryptowithalgo.git /opt/cryptowithalgo
cd /opt/cryptowithalgo
cp .env.production.example .env.production
# Edit .env.production: set domain, secrets, Upstash credentials, MongoDB passwords

# First start
docker compose -f docker-compose.prod.yml up -d --build

# Seed demo data (optional, one-time)
docker build --target seeder -t crypto-seeder .
docker run --rm --network cryptowithalgo_default \
  --env-file .env.production \
  crypto-seeder
```

### GitHub Secrets Setup (one-time)

1. Generate SSH key pair: `ssh-keygen -t ed25519 -C "github-deploy"`
2. Add public key to VPS: `~deploy/.ssh/authorized_keys`
3. Add private key as `VPS_SSH_KEY` secret in GitHub repo settings
4. Add `VPS_HOST`, `VPS_USER`, `VPS_PORT` secrets
5. Add repo as deploy key on GitHub (for `git pull` from VPS)

### Subsequent Deploys (automatic)

Push to `main` -> CI passes -> Deploy workflow SSHs in -> `git pull && docker compose up -d --build`

### Manual Deploy

GitHub Actions > Deploy workflow > "Run workflow" button.

### Rollback

```bash
# SSH into VPS manually
cd /opt/cryptowithalgo
git checkout <previous-commit>
docker compose -f docker-compose.prod.yml up -d --build
```

## Verification Checklist

1. `npm run build` -- confirm standalone output works after adding `output: 'standalone'`
2. `npm run test` -- health endpoint unit test passes
3. `npm run lint && npm run typecheck` -- clean
4. `docker compose -f docker-compose.prod.yml up -d --build` -- all 4 containers healthy
5. `curl http://localhost:3000/api/health` -- returns `{"status":"ok","mongodb":"connected",...}`
6. `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/check-alerts` -- 200
7. `docker logs crypto-cron` -- cron jobs executing on schedule
8. HTTPS working on configured domain via Caddy
9. WebSocket connection to Binance working in browser

## Key Files Referenced

| File | Why |
|------|-----|
| `next.config.ts` | Must add `output: 'standalone'` |
| `src/middleware.ts:44` | Confirms `/api` excluded from auth matcher |
| `src/lib/mongodb.ts` | `mongoose.connection.readyState` for health check |
| `src/app/api/cron/check-alerts/route.ts` | Cron auth pattern reference |
| `scripts/seed.ts` | Uses `@/` aliases, needs full `node_modules` (seeder target) |
| `.gitignore` | Has `.env*` pattern, need `.env.production.example` exception |
| `.github/workflows/ci.yml` | Existing CI workflow -- deploy triggers after this succeeds |
| `docker-compose.yml` | Existing dev-only compose (unchanged) |
