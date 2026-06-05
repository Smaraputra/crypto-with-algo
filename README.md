# Crypto Portfolio Tracker

A modern, real-time cryptocurrency portfolio tracking application built with Next.js 16, featuring live market data from Binance, interactive trading charts, and comprehensive portfolio management.

## Port Configuration

This app uses separate ports for different environments to avoid conflicts:

| Environment | Port | Environment Variable | Usage |
|---|---|---|---|
| Development | 3000 | `PORT` | `npm run dev` |
| Production | Configurable | `PORT` | `PORT=3002 npm start` |
| E2E Tests | 3300 | `TEST_PORT` | `npm run test:e2e` |

### Examples

```bash
# Development (default port 3000)
npm run dev

# Development (custom port)
PORT=8080 npm run dev

# E2E tests (default TEST_PORT 3300, isolated from dev server)
npm run test:e2e

# E2E tests (custom test port)
TEST_PORT=4000 npm run test:e2e

# Production (set PORT in .env.production or via env var)
PORT=3002 npm start
```

### Why Separate Ports?

On VPS deployments with multiple sites, each app runs on a different internal port (3000, 3001, 3002...) with Nginx routing traffic by domain. E2E tests need their own isolated port to avoid conflicts with running dev servers.

**See [VPS-DEPLOYMENT.md](./VPS-DEPLOYMENT.md) for complete multi-site deployment instructions.**

## Features

- **Real-time Market Data**: Live prices via Binance WebSocket
- **Interactive Charts**: KlineCharts v10 with technical indicators
- **Portfolio Management**: Track holdings, P&L, transactions
- **Trading Signals**: Multi-indicator signal system with sentiment analysis
- **Backtesting**: Test strategies against historical data
- **Trading Journal**: Log trades with tags, notes, and performance analytics
- **Research Notes**: Organize market research and playbooks
- **Price Alerts**: Configurable alerts with recurring support
- **Sentiment Analysis**: Fear & Greed Index integration
- **News Feed**: Real-time crypto news aggregation

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19, TypeScript)
- **Auth**: NextAuth.js v5 (credentials + OAuth)
- **Database**: MongoDB 7 (Mongoose ODM)
- **Cache**: Upstash Redis (serverless-compatible)
- **State**: Zustand (client), TanStack React Query (server)
- **Charts**: KlineCharts v10
- **UI**: shadcn/ui (New York style), Tailwind CSS v4
- **Validation**: Zod v4
- **Real-time**: Binance WebSocket streams
- **Testing**: Vitest + Testing Library + Playwright

## Quick Start

### Prerequisites

- Node.js 18+
- MongoDB 7+ (local or Atlas)
- Redis (Upstash recommended)

### Installation

```bash
# Clone repository
git clone https://github.com/Smaraputra/crypto-with-algo.git
cd crypto-with-algo

# Install dependencies
npm install

# Copy environment template
cp .env.example .env.local

# Configure .env.local with your MongoDB, Redis, and OAuth credentials

# Start MongoDB (if local)
docker-compose up -d

# Seed demo data (optional)
npm run seed

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Development

### Available Scripts

```bash
npm run dev          # Start dev server (port 3000 default)
npm run build        # Production build
npm start            # Start production server
npm run lint         # Run ESLint
npm run typecheck    # TypeScript type checking
npm run test         # Run unit tests (Vitest)
npm run test:watch   # Unit tests in watch mode
npm run test:e2e     # Run E2E tests (Playwright, port 3300)
npm run seed         # Seed demo data
```

### Testing

```bash
# Unit tests (192 test files, 1691 tests)
npm run test

# E2E tests (87 tests across 12 spec files)
npm run test:e2e

# Test coverage
npm run test:coverage
```

**Test Status**: All tests passing ✅
- Unit: 194 files, 1691 tests
- E2E: 87 tests
- Coverage: 80%+ on critical paths

## Project Structure

```
src/
├── app/                 # Next.js App Router
│   ├── (auth)/         # Auth pages (login, register)
│   ├── (dashboard)/    # Protected dashboard pages
│   ├── (marketing)/    # Public marketing pages
│   └── api/            # API routes
├── components/         # React components
│   ├── ui/            # shadcn/ui components
│   ├── chart/         # Chart components
│   ├── journal/       # Journal components
│   ├── backtest/      # Backtest components
│   ├── analytics/     # Analytics components
│   └── marketing/     # Marketing components
├── hooks/             # Custom React hooks
├── lib/               # Server utilities
│   ├── models/        # Mongoose models
│   ├── indicators/    # Technical indicators
│   ├── backtest/      # Backtesting engine
│   └── signals/       # Signal computation
├── stores/            # Zustand stores
├── types/             # TypeScript types
├── __fixtures__/      # Test fixtures
└── __mocks__/         # Module mocks
```

## Environment Variables

See `.env.example` for all required variables:

```env
# Core
MONGODB_URI=mongodb://localhost:27017/crypto_dev
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-here

# Redis
UPSTASH_REDIS_REST_URL=your-redis-url
UPSTASH_REDIS_REST_TOKEN=your-token

# Binance
BINANCE_API_URL=https://api.binance.com
NEXT_PUBLIC_BINANCE_WS_URL=wss://stream.binance.com:9443

# OAuth (optional)
GOOGLE_CLIENT_ID=your-google-id
GOOGLE_CLIENT_SECRET=your-google-secret
GITHUB_CLIENT_ID=your-github-id
GITHUB_CLIENT_SECRET=your-github-secret

# Cron
CRON_SECRET=your-cron-secret
```

## Deployment

### Option 1: VPS Multi-Site Deployment

See [VPS-DEPLOYMENT.md](./VPS-DEPLOYMENT.md) for complete guide:
- Nginx reverse proxy setup
- PM2 process manager configuration
- SSL certificate installation
- Multi-site port management

### Option 2: Vercel

```bash
vercel deploy
```

### Option 3: Docker

```bash
docker-compose up -d
```

See `docker-compose.yml` for production stack (Next.js + MongoDB + Redis).

## Documentation

- **[PROJECT.md](./PROJECT.md)**: Feature and architecture overview
- **[docs/TECHNICAL.md](./docs/TECHNICAL.md)**: Detailed technical architecture
- **[VPS-DEPLOYMENT.md](./VPS-DEPLOYMENT.md)**: VPS multi-site deployment guide
- **[CHANGELOG.md](./changelogs/CHANGELOG.md)**: Version history
- **[CONTRIBUTING.md](./CONTRIBUTING.md)**: Development workflow and conventions

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'feat: add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

**Commit Convention**: Conventional Commits (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`)

## Testing Requirements

All changes must pass:
- `npm run lint` - Zero ESLint errors
- `npm run typecheck` - Zero TypeScript errors
- `npm run test` - All unit tests passing
- `npm run test:e2e` - All E2E tests passing
- `npm run build` - Clean production build

## Disclaimer

This is an educational and portfolio project. It is not financial advice. The
market data, signals, backtests, and analytics provided are for informational
purposes only and may be inaccurate, delayed, or incomplete. Cryptocurrency
trading carries significant risk. Do your own research and never trade based
solely on this software. The software is provided "as is", without warranty of
any kind; the author accepts no liability for any losses incurred.

## License

[MIT](./LICENSE)

## Acknowledgments

- Next.js team for the amazing framework
- Binance for market data API
- shadcn for beautiful UI components
- KlineCharts for professional trading charts
