# Shipping Tracker

## Project Status

All 12 development phases (101 steps) are complete. Build passes, TypeScript clean, lint clean, 1659 unit tests passing, 13 E2E spec files.

The app is feature-complete. What remains is VPS setup, deployment, and operational concerns.

## Infrastructure (Self-Hosted VPS)

### 1. MongoDB

| | |
|---|
| **What**: Database for user data, portfolios, journal, signals, backtests |
| **Setup**: Install directly or run via Docker |
| **Option A -- Docker (recommended)**: |
| The existing `docker-compose.yml` already defines a `mongo:7` service. |
| Data persists in a named volume (`mongodb_data`). |
| **Option B -- Native install**: |
| Install `mongod` via package manager, enable as systemd service. |
| **Config**: `MONGODB_URI=mongodb://localhost:27017/cryptowithalgo` |
| **Backups**: Schedule `mongodump` via crontab to a backup location. |

### 2. Redis

| | |
|---|
| **What**: Price caching (30s TTL) and rate limiting |
| **Current situation**: The app uses `@upstash/redis` (HTTP client) and `@upstash/ratelimit`. |
| These libraries talk to Upstash's REST API, not a raw Redis TCP connection. |
| **Two options**: |

**Option A -- Keep Upstash (no code changes)**

Use the free Upstash tier even on VPS. The HTTP client works from anywhere. Zero code changes. Free tier gives 10k commands/day -- more than enough for personal use.

**Option B -- Switch to local Redis (code change required)**

Replace `@upstash/redis` with `ioredis` in `src/lib/redis.ts` and rewrite `src/lib/rate-limit.ts` to use a standard Redis rate limiter. This is a small change (~2 files) but not zero effort. The docker-compose already has a Redis 7 container ready.

**Recommendation**: Start with Option A (Upstash free tier, zero friction). Switch to local Redis later if the 10k/day limit becomes a bottleneck.

### 3. Reverse Proxy (Caddy or Nginx)

| | |
|---|
| **What**: TLS termination, domain routing, static asset serving |
| **Recommended**: Caddy (auto-HTTPS with Let's Encrypt, minimal config) |

Caddy example (`/etc/caddy/Caddyfile`):

| | |
|---|
| `yourdomain.com {`<br>`    reverse_proxy localhost:3000`<br>`}` |

That's the entire config. Caddy auto-provisions and renews SSL certificates.

Nginx alternative requires separate certbot setup for Let's Encrypt.

### 4. Process Manager

| | |
|---|
| **What**: Keep the Next.js process alive, auto-restart on crash/reboot |
| **Options**: pm2 or systemd |

**pm2 (recommended for Node.js)**:

| | |
|---|
| `npm run build`<br>`pm2 start npm --name cryptowithalgo -- start`<br>`pm2 save`<br>`pm2 startup` |

**systemd alternative** (`/etc/systemd/system/cryptowithalgo.service`):

| | |
|---|
| `[Unit]`<br>`Description=CryptoWithAlgo`<br>`After=network.target`<br>`[Service]`<br>`Type=simple`<br>`User=deploy`<br>`WorkingDirectory=/opt/cryptowithalgo`<br>`ExecStart=/usr/bin/npm start`<br>`Restart=always`<br>`EnvironmentFile=/opt/cryptowithalgo/.env.local`<br>`[Install]`<br>`WantedBy=multi-user.target` |

### 5. Cron Jobs (native crontab)

| | |
|---|
| **What**: Alert evaluation, portfolio snapshots, signal refresh, candle sync |
| No external cron service needed -- use the system crontab directly. |

| | |
|---|
| `# crontab -e`<br>`*/1 * * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron/check-alerts`<br>`*/5 * * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" -X POST http://localhost:3000/api/cron/compute-signals`<br>`*/3 * * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron/sync-candles`<br>`0 0 * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" -X POST http://localhost:3000/api/cron/snapshot-portfolios` |

Note: `check-alerts` ideally runs every 30s. Crontab minimum is 1 minute. For sub-minute, use a systemd timer or a simple loop script:

| | |
|---|
| `#!/bin/bash`<br>`while true; do`<br>`  curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/check-alerts`<br>`  sleep 30`<br>`done` |

Run this as a pm2 process or systemd service.

### 6. Domain + DNS

| | |
|---|
| **What**: Point a domain to your VPS IP |
| **Steps**: |
| 1. Buy domain (Namecheap, Cloudflare, Porkbun, etc.) |
| 2. Create an A record pointing to your VPS IP |
| 3. Caddy handles SSL automatically once DNS propagates |
| 4. Set `NEXTAUTH_URL=https://yourdomain.com` |

### 7. OAuth Providers (Optional)

Google OAuth:

| | |
|---|
| 1. Go to console.cloud.google.com |
| 2. Create project -> APIs & Services -> Credentials |
| 3. Create OAuth 2.0 Client ID (Web application) |
| 4. Authorized redirect URI: `https://yourdomain.com/api/auth/callback/google` |
| 5. Copy Client ID -> `GOOGLE_CLIENT_ID`, Secret -> `GOOGLE_CLIENT_SECRET` |

GitHub OAuth:

| | |
|---|
| 1. Go to github.com/settings/developers |
| 2. New OAuth App |
| 3. Authorization callback URL: `https://yourdomain.com/api/auth/callback/github` |
| 4. Copy Client ID -> `GITHUB_CLIENT_ID`, Secret -> `GITHUB_CLIENT_SECRET` |

### 8. Firewall

| | |
|---|
| Only expose ports 80, 443, and 22 (SSH). |
| MongoDB (27017) and Redis (6379) should NOT be exposed externally. |
| `ufw allow 22/tcp`<br>`ufw allow 80/tcp`<br>`ufw allow 443/tcp`<br>`ufw enable` |

## Deployment Flow

### Initial Deploy

| | |
|---|
| 1. SSH into VPS |
| 2. Install Node.js 20, Docker, Caddy, pm2 |
| 3. Clone repo: `git clone <repo-url> /opt/cryptowithalgo` |
| 4. `cd /opt/cryptowithalgo` |
| 5. Start MongoDB: `docker compose up -d mongodb` |
| 6. Copy `.env.example` to `.env.local`, fill in values |
| 7. `npm ci --production=false` (need devDeps for build) |
| 8. `npm run build` |
| 9. `pm2 start npm --name cryptowithalgo -- start` |
| 10. Configure Caddy with your domain |
| 11. Set up crontab entries |
| 12. `pm2 save && pm2 startup` |

### Subsequent Deploys

| | |
|---|
| `cd /opt/cryptowithalgo`<br>`git pull origin main`<br>`npm ci`<br>`npm run build`<br>`pm2 restart cryptowithalgo` |

Or automate with a simple deploy script or GitHub Actions SSH deploy.

### CI/CD

The existing `.github/workflows/ci.yml` runs lint, typecheck, unit tests, build, and E2E on every push. For auto-deploy to VPS, add a deploy job that SSHs in and runs the deploy steps above (or use a webhook + deploy script on the VPS).

## Environment Variables

| Variable | Required | Value |
|----------|----------|-------|
| `MONGODB_URI` | Yes | `mongodb://localhost:27017/cryptowithalgo` |
| `NEXTAUTH_SECRET` | Yes | Generate: `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Yes | `https://yourdomain.com` |
| `UPSTASH_REDIS_REST_URL` | Recommended | Upstash REST URL (or omit if skipping cache) |
| `UPSTASH_REDIS_REST_TOKEN` | Recommended | Upstash REST token |
| `BINANCE_API_URL` | No (defaults) | `https://api.binance.com/api/v3` |
| `NEXT_PUBLIC_BINANCE_WS_URL` | No (defaults) | `wss://stream.binance.com:9443` |
| `BINANCE_FUTURES_API_URL` | No (defaults) | `https://fapi.binance.com` |
| `CRON_SECRET` | Yes | Random string for cron auth |
| `GOOGLE_CLIENT_ID` | No | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth |
| `GITHUB_CLIENT_SECRET` | No | GitHub OAuth |
| `PORT` | No | Defaults to 3000 |
| `NODE_ENV` | No | Set to `production` (pm2/systemd) |

## Pre-Ship Checklist

### Code Quality (All Passing)

- [x] `npm run lint` -- zero errors (6 non-blocking warnings)
- [x] `npm run typecheck` -- zero type errors
- [x] `npm run test` -- 1659 unit tests passing
- [x] `npm run build` -- clean production build
- [x] `npm run test:e2e` -- all E2E suites passing
- [x] No hardcoded secrets in source
- [x] CSP headers configured
- [x] Security headers (X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy)
- [x] CI/CD pipeline (`.github/workflows/ci.yml`)

### VPS Setup

- [ ] VPS provisioned (Ubuntu 22.04+ or Debian 12+)
- [ ] Node.js 20 installed
- [ ] Docker installed and running
- [ ] Caddy installed
- [ ] pm2 installed globally (`npm i -g pm2`)
- [ ] Firewall configured (22, 80, 443 only)
- [ ] Non-root deploy user created

### Services

- [ ] MongoDB running (Docker or native)
- [ ] Upstash Redis account created (or skip for no-cache mode)
- [ ] App cloned, built, and running via pm2
- [ ] Caddy configured with domain, SSL active
- [ ] Cron jobs configured in crontab
- [ ] pm2 startup hook enabled (auto-restart on reboot)

### Domain + Auth

- [ ] Domain purchased and A record pointing to VPS IP
- [ ] DNS propagated, HTTPS working
- [ ] `NEXTAUTH_SECRET` generated and set in `.env.local`
- [ ] `NEXTAUTH_URL` set to production domain
- [ ] Test email/password registration
- [ ] (Optional) Google OAuth app created, redirect URI set
- [ ] (Optional) GitHub OAuth app created, callback URL set

### Smoke Test (Post-Deploy)

- [ ] Landing page loads over HTTPS
- [ ] Registration works (email/password)
- [ ] Login works and redirects to dashboard
- [ ] Dashboard shows live prices (WebSocket connected)
- [ ] Trading chart renders with candle data
- [ ] Can create portfolio and add holdings
- [ ] Alerts can be created
- [ ] Signals page computes indicators
- [ ] Journal entry can be created
- [ ] Backtest runs and produces results
- [ ] Cron endpoints return 200 when hit manually

### Binance API Access

- [ ] Verify Binance REST responds (not 403) from VPS IP
- [ ] If 403: set `BINANCE_API_URL` to a proxy or use a non-US VPS
- [ ] WebSocket streams connect from client browser
- [ ] Futures endpoints respond for funding/OI data

## Operational Concerns

### Backups

| | |
|---|
| Schedule `mongodump` nightly to a backup directory or remote storage: |
| `0 3 * * * mongodump --uri="mongodb://localhost:27017/cryptowithalgo" --out=/backups/mongo/$(date +\%Y\%m\%d)` |
| Rotate old backups with `find /backups/mongo -mtime +30 -delete` |

### Monitoring

| | |
|---|
| `pm2 monit` -- real-time process monitoring |
| `pm2 logs cryptowithalgo` -- application logs |
| Consider: UptimeRobot (free) for uptime alerts on your domain |

### Log Rotation

| | |
|---|
| pm2 handles log rotation with `pm2-logrotate`: |
| `pm2 install pm2-logrotate` |
| `pm2 set pm2-logrotate:max_size 10M` |
| `pm2 set pm2-logrotate:retain 7` |

### Updates

| | |
|---|
| `git pull && npm ci && npm run build && pm2 restart cryptowithalgo` |
| Zero-downtime: use `pm2 reload` instead of `restart` (requires cluster mode). |

## Known Risks

**Binance geo-restrictions**: Binance REST API returns 403 from US IPs. If your VPS is US-based, server-side Binance calls will fail. Mitigations: use a non-US VPS, or set `BINANCE_API_URL` to a reverse proxy in a non-restricted region.

**No serverless timeout limits**: Unlike Vercel, your VPS has no function timeout. Backtests can run as long as needed. This is an advantage.

**Single point of failure**: One VPS means one server. If it goes down, the app goes down. For personal/small-scale use this is fine. For higher availability, add a health check monitor (UptimeRobot) to get notified.

**next-auth beta**: Using v5 beta. Stable but not officially GA. Pin version in package.json to avoid breaking updates.

**MongoDB without auth**: The docker-compose runs MongoDB without authentication. Fine for localhost-only access with firewall rules, but add `--auth` and create users if the VPS is shared or MongoDB port is exposed.

## Cost Estimate

| Service | Monthly Cost |
|---------|-------------|
| VPS | Already owned |
| Domain | ~$1/month (~$12/year) |
| Upstash Redis (free tier) | $0 |
| UptimeRobot (free) | $0 |
| **Total** | **~$1/month** |

## Untracked Files to Resolve

These files are in the working tree but not committed:

| | |
|---|
| `api-reference-page.png` |
| `blog-page.png` |
| `docs-page.png` |
| `landing-hero.png` |
| `reference-site.html` |

Decision needed: commit these as assets, move to a design folder, or add to `.gitignore`.
