# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Landing page mobile UX and content accuracy
  - Increased base font sizes for better mobile readability (text-xs → text-sm on mobile)
  - Reduced hero section padding on mobile (pt-24 pb-12)
  - Reduced globe height on mobile (h-[250px])
  - Increased touch target height for buttons (h-10 → h-11)
  - Disabled CursorGlow animation on touch devices for better performance
  - Removed fake statistics ("99.9% Uptime", "6 Exchanges")
  - Removed misleading API key integration claims from How It Works steps
  - Fixed GitHub social link to point to actual repository
  - Removed dead X/Twitter link
  - Replaced dead Blog and Documentation links with Features and How It Works

### Added
- Legal placeholder pages (/terms, /privacy) with proper navigation
- Legal links in Footer (Terms of Service, Privacy Policy)
- Test for CursorGlow touch device detection

### Changed
- VPS deployment guide now uses Caddy reverse proxy instead of Nginx
  - Automatic HTTPS with Let's Encrypt (zero manual certificate management)
  - Simpler configuration syntax (Caddy vs Nginx+certbot)
  - Built-in HTTP/2 and HTTP/3 support
  - Multi-site setup with automatic SSL for all domains
- Updated HeroSection stats to reflect actual implementation (24/7 Monitoring, < 1s Updates, 100% Free)
- Updated HowItWorks steps to match session-based auth flow (Register, Configure, Track)
- Updated Features platform highlights to clarify manual portfolio entry
- Updated hero subheadline to emphasize free tier and no API key requirement
- Container widths expanded on large screens (max-w-6xl lg:max-w-7xl)

### Added (Test Suite Audit Phase 3)
- Comprehensive tests for candles API routes (26 new tests, 2 test files)
  - GET /api/candles route tests (auth, validation, auto-backfill logic, error handling)
  - POST /api/candles/backfill route tests (auth, validation, backfill stats, error handling)
  - Increases total test coverage to 194 files with 1691 tests (from 192 files, 1665 tests)

### Fixed (Test Suite Audit Phases 1-2)
- **Phase 1 - E2E Tests**: Fixed 4 failing E2E tests (viewport, timing, outdated assertions)
  - Playwright config now sets explicit desktop viewport (1280x720) for unauthenticated tests
  - Journal review queue E2E test now waits for loading state completion before assertions
  - Backtest Journal tab E2E test updated to match current implementation (redirect message instead of JournalList)
  - Test project configuration updated to properly exclude unauthenticated tests from authenticated project
  - Dev server port changed to 3300 to avoid conflicts
  - All 87 E2E tests now passing (previously 83/87)
- **Phase 2 - Unit Test Audit**: Audited high-risk test files for obsolete patterns and Phase 10-12 schema changes
  - Verified scorer tests include comprehensive sentiment integration testing
  - Verified journal API tests validate Phase 10 schema fields (tags, setupType, marketCondition, sentiment)
  - Verified journal hooks test new query filters
  - Assessed component test quality - all tests are behavioral (not shallow rendering)
  - Result: Zero obsolete tests found, all tests current and high-quality

### Added (Phase 12: Journal Analytics -- Steps 98-101)
- Journal analytics API with MongoDB aggregation pipelines: summary stats, tag performance, action distribution, setup type analysis, market condition breakdown, monthly P&L, signal tier accuracy (`/api/journal/analytics`)
- AnalyticsSummaryCards component (total trades, win rate, P&L, profit factor)
- WinRateByTag component with horizontal color-coded bars
- PerformanceBySetup table with win rate and avg P&L per setup type
- MonthlyPnL diverging bar chart (green/red by month)
- SignalAccuracy table showing avg P&L and win rate per signal tier
- TradingPatterns behavioral analysis (overtrading detection, streak detection, profit factor assessment)
- AnalyticsView composition component wiring all analytics sub-components
- Journal page Analytics tab activated (replaces placeholder)
- Journal page unit tests and E2E spec
- `useJournalAnalytics` React Query hook

### Added (Phase 11: Research Notes & Sentiment -- Steps 92-97)
- ResearchNote Mongoose model with categories, tags, related symbols, pin support
- Research notes API routes (CRUD, filter by category/tag/search, pagination)
- Research notes React Query hooks (list, create, update, delete)
- PlaybookView two-panel layout (search, category filter, note list, markdown detail)
- ResearchNoteCard and ResearchNoteForm components
- Fear & Greed Index integration via alternative.me API (`fetchFearAndGreed`)
- Sentiment data now feeds into signal computation (`scoreSentiment` activated)
- Crypto news aggregation via CryptoCompare API (`fetchCryptoNews`)
- NewsFeed dashboard widget with time-ago formatting
- `/api/sentiment` endpoint and `useFearAndGreed` hook
- SentimentGauge component with color-coded bar (0-100)
- Sentiment display on signals page and auto-populate in EnhancedJournalForm

### Added (Phase 10: Enhanced Journal -- Steps 86-91)
- Journal schema expansion: tags, indicator snapshots, strategy/backtest links, lessons learned, setup type, market condition, sentiment
- Journal API filtering (tag, action, setup, condition, date range), pagination, auto P&L computation
- Tags endpoint (`/api/journal/tags`) via MongoDB aggregation
- Enhanced journal form with markdown notes, tag input, indicator snapshot capture
- JournalEntryDetail full card view with snapshot grid and tags
- ReviewDialog for closed trade review with lessons learned
- Dedicated `/journal` page with Entries, Review Queue, Playbook, Analytics tabs
- JournalFilterBar, JournalEntryList, ReviewQueue components
- Sidebar Journal navigation item
- `useIndicatorSnapshot` hook for live signal data extraction

### Changed (Phase 9: Polish & Accessibility -- Steps 81-85)
- `useBinanceTicker` now batches WebSocket messages via `requestAnimationFrame` instead of per-message setState (Step 81)
- `PriceCard` wrapped in `React.memo` with custom comparator for skip-render optimization (Step 81)
- `MarketOverview` merged tickers wrapped in `useMemo` (Step 81)
- Replaced hardcoded hex colors (#0ecb81, #f6465d, #848e9c, text-green-500, text-red-500) with CSS theme variables across SignalGauge, SignalBreakdown, FuturesPanel, TradeList, BacktestMetricsCards (Step 83)

### Added (Phase 9: Polish & Accessibility -- Steps 81-85)
- Skip-to-content link and `id="main-content"` on dashboard layout (Step 82)
- `role="alert"` on error divs in login and register pages (Step 82)
- `aria-live="polite"` on NotificationBell notification list (Step 82)
- `aria-label="Select {symbol}/USDT"` on PriceCard buttons (Step 81)
- Signal tier CSS variables: `--signal-strong-buy`, `--signal-buy`, `--signal-neutral`, `--signal-sell`, `--signal-strong-sell` (Step 83)
- `Cache-Control` headers on `/api/prices` (30s) and `/api/prices/history` (TTL-based per interval) (Step 84)
- Toast error feedback on watchlist mutation failure via sonner (Step 85)

### Changed (Landing Page Redesign -- Ethena-Inspired)
- Redesigned landing page with ultra-dark, premium aesthetic inspired by ethena.fi
- Scoped darker theme to marketing and auth layouts via `.marketing-dark` CSS class
- LandingNav: pill-shaped container with center anchor links (Features, How It Works), backdrop blur
- LandingButton: pill shape (`rounded-full`), new `gradient-border` variant
- HeroSection: two-column layout with left-aligned text and right-side 3D globe, integrated stats bar (6 stats with gradient values and icons)
- HeroBackground: simplified to radial gradient glow with dot-matrix pattern overlay
- FeaturesSection: gradient heading, grid-overlay cards with green glow hover, `id="features"` anchor
- HowItWorksSection: gradient heading, green-tinted connector lines, `id="how-it-works"` anchor
- CTASection: full-width layout with dot-grid pattern background, gradient heading
- Footer: multi-column layout (Brand, Product, Resources, Account columns)
- GlobeScene: recolored from yellow (#f0b90b) to green (#0ecb81) to match primary accent
- Auth layout: darker aesthetic via marketing-dark class

### Added (Landing Page Redesign -- Ethena-Inspired)
- CSS utilities: `.gradient-heading`, `.grid-card-overlay`, `.gradient-separator`
- Marketing-scoped CSS custom properties (darker bg, card, border values)

### Removed (Landing Page Redesign -- Ethena-Inspired)
- CoinScene and CoinSceneWrapper components (globe moved into HeroSection)
- AnimatedChartSection component
- StatsSection component (stats merged into HeroSection stats bar)

### Added (Phase 8: Backtesting Engine -- Steps 70-76)
- Strategy CRUD API routes (`/api/strategies`, `/api/strategies/[id]`) with auth, Zod validation, ownership checks, and 5-per-user limit
- Strategy types and schemas (`src/types/strategy.ts`) with weight sum validation (must equal 1.0)
- TanStack Query hooks for strategies (`useStrategies`, `useStrategy`, `useCreateStrategy`, `useUpdateStrategy`, `useDeleteStrategy`)
- Strategy configuration UI: `StrategyForm` (dialog with weight sliders, symbol/interval selectors) and `StrategyList` (card grid with edit/delete)
- Backtest engine core (`src/lib/backtest/engine.ts`): bar-by-bar signal evaluation over pre-computed indicators
- Backtest metrics calculator (`src/lib/backtest/metrics.ts`): Sharpe, Sortino, Calmar ratios, profit factor, max drawdown, win rate, consecutive streaks
- Indicator bar interpreter (`src/lib/indicators/interpret-at-bar.ts`): reads pre-computed indicator arrays at offset-aligned indices for backtesting
- Exported 12 individual interpreter functions from `src/lib/indicators/interpret.ts` for reuse in backtest engine
- IndexedDB candle cache (`src/lib/candle-cache.ts`) with TTL (1h intraday, 6h daily), LRU eviction, max 50 entries
- Web Worker backtest runner (`src/workers/backtest.worker.ts`) with progress callback messages
- `useBacktest` hook managing Worker lifecycle (idle/running/complete/error states, progress tracking, cancel)
- Equity curve chart (`EquityCurveChart`) using lightweight-charts v5 AreaSeries with green/red profit coloring
- Backtest metrics cards (`BacktestMetricsCards`) with 12 metric items in responsive grid
- Trade list table (`TradeList`) with color-coded rows, PnL formatting, exit reason display
- Backtest configuration panel (`BacktestConfigPanel`) with inputs for thresholds, SL/TP, position size, fees, starting capital
- Progress bar component (`BacktestProgress`) with bars-processed counter and accessible progressbar role
- Full backtest page with tabs (Configure/Results), strategy selector, interval selector, run/cancel controls
- Backtest error boundary page
- "Backtest" navigation item in sidebar (FlaskConical icon)
- 147 new unit tests across 23 test files (1189 total, 136 files)
- Test fixtures for strategies (`src/__fixtures__/strategies.ts`)

### Added (Phase 8: Backtesting Engine -- Steps 77-80)
- Signal journal model (`src/lib/models/journal-entry.ts`) with userId+symbol indexes for tracking signal outcomes
- Signal journal types and Zod schemas (`src/types/journal.ts`) with create/update validation
- Journal CRUD API routes (`/api/journal`, `/api/journal/[id]`) with auth, 500-entry limit, symbol filtering
- TanStack Query hooks for journal (`useJournalEntries`, `useJournalEntry`, `useCreateJournalEntry`, `useUpdateJournalEntry`, `useDeleteJournalEntry`)
- Position sizing calculators (`src/lib/backtest/position-sizing.ts`): fixed fractional, Kelly criterion (half-Kelly default), risk-based
- `PositionSizingConfig` type with `fixed_percent | fixed_fractional | kelly | risk_based` methods
- Backtest engine now uses position sizing method selection (falls back to fixed percent if not configured)
- Backtest results persistence model (`src/lib/models/backtest-result.ts`) with 50-result limit
- Backtest results types (`src/types/backtest.ts`) with summary vs detail response types
- Backtest results API routes (`/api/backtests`, `/api/backtests/[id]`) with list (summaries, no trades/equityCurve), detail, save, delete
- TanStack Query hooks for saved results (`useBacktestResults`, `useBacktestResultDetail`, `useSaveBacktestResult`, `useDeleteBacktestResult`)
- "Save Result" button on backtest Results tab
- "History" tab on backtest page showing saved results table with PnL, win rate, delete action
- "Journal" tab on backtest page with full journal list, symbol filtering, and entry cards
- `JournalEntryCard` component with action badges (color-coded buy/sell/hold/skip), PnL display, notes
- `JournalList` component with symbol filter buttons, loading/empty states, delete support
- `JournalForm` dialog component with action selector, notes textarea, pre-filled signal data
- "Log to Journal" button on Signals page (visible when a signal is computed)
- E2E tests for backtest page (7 specs: tabs, intervals, history, journal, strategy form)
- 82 new unit tests across 11 test files (1271 total, 147 files)
- Test fixtures for journal entries (`src/__fixtures__/journal.ts`)
- shadcn/ui Textarea component added

### Added (Landing Page Redesign)
- GSAP ScrollTrigger animations replacing Framer Motion on all marketing sections
- Lenis smooth momentum scrolling for marketing layout (SmoothScroll wrapper)
- GSAP utility module (`src/lib/gsap.ts`) registering ScrollTrigger and TextPlugin
- LandingButton component with fill-sweep hover effect (outline variant) and solid accent variant
- HeroBackground with parallax gradient orbs and self-drawing SVG chart line
- Interactive 3D wireframe globe (GlobeScene) with fibonacci sphere distribution, mouse-reactive tilt, and connection lines
- HowItWorksSection (Connect, Configure, Automate) with GSAP staggered reveal and horizontal connector lines
- StatsSection with GSAP-powered animated number counters (99.9% Uptime, 50ms Latency, 10K+ Users, 24/7 Monitoring)
- Mouse-tracking radial gradient spotlight effect on feature cards
- Rotating conic-gradient border glow on CTA card
- Footer social links (GitHub, X/Twitter)
- GSAP and Lenis test mocks (`src/__mocks__/gsap.ts`, `src/__mocks__/@gsap/react.ts`, `src/__mocks__/lenis.ts`)
- 47 new unit tests across 14 test files (1089 total, 123 files)
- 6 new E2E assertions for new sections (76 total)

### Changed (Landing Page Redesign)
- HeroSection: GSAP TextPlugin typewriter on accent span, staggered entry via `data-hero-anim` attributes
- AnimatedChartSection: GSAP strokeDashoffset draw with data points, price labels, glow filter, dot grid background
- FeaturesSection: GSAP ScrollTrigger stagger with mouse spotlight cards (CSS custom properties)
- CTASection: GSAP fade-in, rotating gradient border, dot grid background pattern
- CoinSceneWrapper: renamed to reference GlobeScene, heading changed to "Global Algorithmic Network"
- Footer: added tagline "Built for traders, by traders." and social links
- Landing page section order: Hero > Globe > Chart > Features > HowItWorks > Stats > CTA

### Dependencies (Landing Page Redesign)
- Added: `gsap`, `@gsap/react`, `lenis`

### Added (Phase 7: MVP Signal System)
- Server-side technical analysis engine using `technicalindicators` (EMA, SMA, RSI, MACD, Bollinger Bands, ATR, StochasticRSI, WilliamsR, IchimokuCloud, OBV, MFI)
- Custom SuperTrend indicator implementation using ATR bands
- Signal interpretation layer converting raw indicators into categorized bullish/bearish/neutral signals
- Binance Futures REST client (funding rates, open interest, long/short ratio) with `BINANCE_FUTURES_API_URL` env var
- Auth-gated Futures API routes with Redis caching (`/api/futures/funding`, `/api/futures/open-interest`, `/api/futures/long-short`)
- Weighted confluence signal scoring engine (6 categories: trend 25%, momentum 25%, volume 15%, volatility 10%, futures 15%, sentiment 10%)
- Signal tier classification: strong_buy (>60), buy (30-60), neutral (-30 to 30), sell (-60 to -30), strong_sell (<-60)
- Signal and Strategy Mongoose models with 90-day TTL auto-cleanup
- Signal computation API (`POST /api/signals/compute`) and listing API (`GET /api/signals`)
- Cron-based batch signal computation (`GET /api/cron/compute-signals`) for active strategies
- TanStack Query hooks: `useSignals`, `useLatestSignal`, `useComputeSignal`, `useFundingRate`, `useOpenInterest`, `useLongShortRatio`
- SVG semicircular SignalGauge component with gradient arc and animated needle
- SignalBreakdown component with per-category score bars and indicator badges
- FuturesPanel component with funding rate, open interest, and long/short ratio visualization
- Signals page at `/signals` with symbol selector, interval picker, compute button, gauge, breakdown, futures panel, and history table
- Signals nav item in sidebar with Activity icon
- Test fixtures for signals and futures data (`src/__fixtures__/signals.ts`, `src/__fixtures__/futures.ts`)
- 239 new unit tests across 29 test files (1042 total)
- 8 new E2E tests for signals page (70 total)

### Dependencies
- Added: `technicalindicators` (server-side TA computation)

### Added
- Framer Motion scroll-triggered animations on HeroSection (staggered entrance), FeaturesSection (card stagger), and AnimatedChartSection (SVG path draw)
- 3D rotating coin section using Three.js + React Three Fiber (dynamically imported, SSR-disabled)
- AnimatedChartSection with SVG upward-trending price curve, gradient fill, and useInView scroll trigger
- CoinSceneWrapper with skeleton loading state and dynamic import
- Test mocks for framer-motion, @react-three/fiber, and @react-three/drei
- CSP `worker-src 'self' blob:` directive for Three.js web worker support
- 34 new unit tests across 4 new test files (CoinScene, CoinSceneWrapper, AnimatedChartSection + updated existing)

### Changed
- Rebranded from "Crypto Portfolio Tracker" / "Crypto Tracker" to "AlgoCrypto" across all files, tests, and E2E specs
- Replaced Star icon with Zap icon (lucide-react) in nav, footer, sidebar, and auth layout
- Hero heading updated to "Algorithmic Crypto Intelligence / Powered by AlgoCrypto"
- Landing page section order: Hero, CoinScene, AnimatedChart, Features, CTA (removed StatsSection)
- FeaturesSection converted to client component with framer-motion scroll animations

### Removed
- StatsSection component (replaced by AnimatedChartSection and CoinSceneWrapper)

### Dependencies
- Added: framer-motion, three, @react-three/fiber, @react-three/drei, @types/three (devDep)

### Added
- Public marketing landing page at `/` with LandingNav, HeroSection, FeaturesSection, StatsSection, CTASection, and Footer
- Marketing route group `(marketing)` with bare layout
- Animated mock price ticker on hero section (BTC, ETH, SOL, BNB)
- CSS animations: `animate-float` and `animate-fade-in-up` for landing page
- Auth page branding: grid pattern background, radial gradient glow, Star icon header
- Landing page E2E tests (6 tests in `e2e/landing.spec.ts`)
- Unit tests for all marketing components (17 tests across 5 test files)
- Skip-to-content link in marketing layout for keyboard navigation
- Focus trap and Escape-key close for mobile hamburger menu
- ARIA attributes on animated ticker: `role="status"`, `aria-label`, `aria-live="polite"`
- `aria-expanded` attribute on hamburger toggle button
- Mobile viewport Playwright project with 7 E2E tests (`e2e/landing-mobile.spec.ts`)
- Marketing layout unit tests (3 tests)
- Data seeder script (`scripts/seed.ts`) with real Binance market data and fallback prices
- `npm run seed` command for populating demo account with portfolio, watchlist, alerts, and 30-day snapshots
- Seeder unit tests (15 tests in `scripts/seed.test.ts`)

### Changed
- Dashboard route moved from `/` to `/dashboard` to make room for public landing page
- Sidebar nav Dashboard link updated from `/` to `/dashboard`
- Auth callbacks (login/register) redirect to `/dashboard` instead of `/`
- Middleware: `/` is now a public route (exact match); `/login` and `/register` remain prefix-matched
- All hardcoded hex colors replaced with design tokens (`text-bullish`, `text-bearish`, `bg-bullish`, `bg-bearish`, `text-accent`, `border-accent`)
- Ghost button hover changed from `bg-accent` to `bg-muted` for subtler dark-on-dark appearance
- Sidebar and watchlist hover states removed `/50` opacity for better visibility
- Table row hover changed from `bg-muted/50` to `bg-muted`
- Base border radius bumped from `0.25rem` to `0.5rem` (fixes `radius-sm` computing to 0px)

### Fixed
- Flaky E2E alert deletion test: replaced `waitForTimeout` with proper Playwright assertions that wait for DOM state changes
- Toaster color bug: CSS variables wrapped in `hsl()` but containing oklch values; now uses raw `var()` references
- WCAG AA contrast: bumped `--muted-foreground` luminance from 0.6 to 0.65, `--destructive` and `--bearish` from 0.62 to 0.68
- Removed opacity modifiers (`/50`, `/70`) on `text-muted-foreground` in AlertList empty state

### Added
- NextAuth.js v5 configuration with Credentials, Google, and GitHub providers
- Mongoose User model with name, email, password (optional), image, emailVerified, timestamps
- JWT session strategy with `jwt` and `session` callbacks injecting user.id
- `loginSchema` and `authorizeCredentials()` exported separately for testability
- `MongoDBAdapter` with lazy client initialization via function ref (no eager DB call at import)
- Registration endpoint (`POST /api/auth/register`) with Zod validation, bcrypt hashing (12 rounds)
- Rate limiting on registration using `createRateLimiter` factory pattern
- Try-catch on `req.json()` in register route for malformed JSON handling
- Route-protecting middleware with cookie-based session check (edge-compatible)
- Public path allowlist (`/login`, `/register`) in middleware
- Secure cookie check (`__Secure-authjs.session-token`) for HTTPS environments
- Unit tests for User model (6 tests) with mongodb-memory-server integration
- Unit tests for auth config (13 tests): loginSchema validation, authorizeCredentials, JWT/session callbacks
- Unit tests for register route (8 tests): validation, duplicate email, success, rate limiting
- Unit tests for middleware (6 tests): public paths, redirects, cookie checks
- MongoDB Mongoose singleton client with globalThis cache, retry-on-failure, bufferCommands disabled
- Upstash Redis client with graceful degradation (null when env vars missing)
- `cachedFetch<T>()` cache-aside helper with try-catch on Redis operations (no double-stringify)
- Sliding window rate limiter factory (`createRateLimiter`) with singleton pattern
- `rateLimit()` helper returning 429 NextResponse with rate limit headers
- Reusable Redis mock (`src/__mocks__/redis.ts`) for future test files
- Integration tests for MongoDB (mongodb-memory-server): connection, caching, env validation, retry
- Unit tests for Redis client and cachedFetch: cache hit/miss, error handling, no double-stringify
- Unit tests for rate limiter: null redis, allow/block, IP extraction, error fallthrough
- Binance Pro Dark theme with oklch color tokens (globals.css)
- Inter (sans) + JetBrains Mono (mono) font configuration
- `cn()` utility (clsx + tailwind-merge) for class composition
- shadcn/ui base components: Button, Card, Input, Label, Badge, Separator
- Trading color tokens: bullish (green), bearish (red), accent (yellow)
- Price display utilities: `.price-display`, `.price-lg`, `.price-md`, `.price-sm`
- Price flash animations: flash-bullish/bearish, price-up/down, shimmer, pulse-ring
- Custom scrollbar styling, live indicator, scrollbar-hide utility
- Reduced motion media query support
- Unit tests for cn(), Button, Card, Badge components (35 tests total)
- Vitest test framework with jsdom environment and Testing Library
- Playwright E2E test framework configuration
- GitHub Actions CI pipeline (lint, type-check, unit tests, build)
- Project configs: .editorconfig, .prettierrc, components.json
- Docker Compose for local MongoDB + Redis
- Environment variable template with configurable Binance URLs
- Canary test verifying test infrastructure works
- Zustand UI store (`useUIStore`) with sidebar, symbol, and interval state
- Market type definitions: `OHLCV`, `Symbol`, `Ticker24h`, `TickerPrice`
- NextAuth.js v5 module augmentation for typed `Session`, `User`, `JWT`
- Unit tests for uiStore (11 tests)
- Login page with email/password form, Zod validation, `signIn('credentials')` with error handling
- Register page with name/email/password/confirm form, Zod `.refine()` for password match
- OAuth buttons (Google, GitHub) on both login and register pages
- Auto-login after registration with graceful fallback message on failure
- `Providers` wrapper component with `SessionProvider` and `QueryClientProvider` (staleTime 30s)
- `Toaster` from sonner in root layout (dark theme, bottom-right)
- Auth layout with centered card container (`max-w-md`)
- Suspense boundary for `useSearchParams` in login page
- Unit tests for Providers (3 tests), login page (9 tests), register page (11 tests)
- E2E test specs for auth pages (5 tests, requires Docker services)
- Binance REST client (`src/lib/binance.ts`) with configurable `BINANCE_API_URL` env var
- `fetchTickers()` -- fetches 24h tickers filtered to USDT pairs
- `fetchKlines(symbol, interval, limit?)` -- fetches OHLCV klines with float parsing
- `fetchSymbols()` -- fetches exchange info filtered to TRADING status + USDT quote
- Unit tests for Binance client (14 tests): tickers, klines, symbols, base URL config
- Price ticker API route (`GET /api/prices`) -- returns top 15 USDT pairs with 30s Redis cache
- OHLCV history API route (`GET /api/prices/history`) -- Zod-validated params (symbol, interval, limit), interval-specific TTLs (10s-600s)
- Unit tests for price routes (14 tests): success, validation, TTL verification, cache key structure, error handling
- Generic `useWebSocket<T>` hook with auto-reconnect, exponential backoff, pub/sub message handlers
- `useBinanceTicker(symbols)` hook for real-time 24h ticker streams (multi-symbol multiplexing)
- `useBinanceKline(symbol, interval)` hook for real-time candlestick streams with OHLCV transform
- `MockWebSocket` test utility for deterministic WebSocket unit testing
- Unit tests for WebSocket hooks (29 tests): connection lifecycle, reconnection, backoff, message handling, URL changes
- Dashboard layout shell with `(dashboard)` route group
- Header component with desktop sidebar toggle, mobile menu button, user dropdown with sign-out
- Sidebar component with collapsible desktop aside and controlled mobile Sheet (fixed broken reference Sheet)
- Dashboard nav items: Dashboard (active), Portfolio (disabled, "Soon"), Alerts (disabled, "Soon")
- `mobileSidebarOpen` state in Zustand uiStore (independent of desktop `sidebarOpen`)
- shadcn/ui DropdownMenu and Sheet components
- Dashboard home page with server-side `auth()` session greeting
- E2E test spec for dashboard layout (6 tests, auth-gated tests require Docker)
- Unit tests for Header (8 tests), Sidebar (9 tests), uiStore mobileSidebarOpen (4 tests)
- `useTickers()` TanStack Query hook for REST ticker data with 30s polling interval
- `useMarketData(symbol, interval, limit?)` TanStack Query hook for OHLCV candlestick history with 60s staleTime
- Test fixtures (`src/__fixtures__/binance.ts`) with mock `Ticker24h[]` and `OHLCV[]` data
- Unit tests for useTickers (5 tests): fetch, success, error, query key, refetchInterval
- Unit tests for useMarketData (7 tests): URL params, success, error, disabled state, default limit, query key, cache separation
- `PriceCard` component -- compact button with symbol/price/change, flash-up/flash-down animations on price changes, live indicator dot, selected state styling
- `MarketOverview` component -- 8-symbol responsive grid (BTC, ETH, BNB, SOL, XRP, DOGE, ADA, AVAX), merges REST + WebSocket data with live priority, shimmer loading state
- shadcn/ui `Skeleton` primitive component
- Unit tests for PriceCard (12 tests): formatting, bullish/bearish styling, flash animations, live indicator, selection, click handler
- Unit tests for MarketOverview (7 tests): loading skeletons, data merge, REST fallback, symbol selection, live indicator
- `TradingChart` component -- KlineCharts v10 with DataLoader integration, Binance kline WebSocket, Binance Pro Dark theme styling
- `periodToInterval()` exported utility for KlineCharts Period to Binance interval conversion
- Configurable WebSocket base URL via `NEXT_PUBLIC_BINANCE_WS_URL` env var (matching `useBinanceStream` pattern)
- Interval selector tabs (1m, 5m, 15m, 1H, 4H, 1D) with KlineCharts Period mapping
- Technical indicators dropdown with overlay (MA, EMA, BOLL, SAR), oscillator (MACD, RSI, KDJ), and volume (VOL, OBV) groups
- Drawing tools toolbar: Trendline, Horizontal Line, Fibonacci Retracement, Parallel Channel, Clear
- Live/Connecting WebSocket status indicator with tooltip
- Loading overlay with spinner animation during data fetch
- Refresh button to reset chart data
- `DashboardChart` wrapper component wiring Zustand store (selectedSymbol, selectedInterval) to TradingChart
- `useChartResize` hook -- native ResizeObserver with 100ms debounce for responsive chart sizing
- shadcn/ui Tabs and Tooltip components
- Unit tests for useChartResize (8 tests): dimensions, debouncing, resize callback, observer lifecycle
- Unit tests for TradingChart (19 tests): periodToInterval utility, toolbar rendering, chart init, indicators, drawing tools, cleanup
- Unit tests for DashboardChart (3 tests): store defaults, interval change propagation, symbol reflection

- `useWatchlist` TanStack Query hook with optimistic updates, rollback on error, and `addSymbol`/`removeSymbol` convenience methods
- `WatchlistSidebar` component with live ticker prices, 24h change %, add/remove symbols via dropdown, selected symbol highlighting
- Sidebar integration: WatchlistSidebar rendered below navigation with scrollable container
- Unit tests for useWatchlist (10 tests): fetch, success, error, query key, add/remove, duplicate skip, optimistic update/rollback
- Unit tests for WatchlistSidebar (10 tests): loading skeleton, header, symbols, prices, colors, selection, click handlers, empty state

- Watchlist Mongoose model (`src/lib/models/watchlist.ts`) with userId (unique, indexed) and symbols (default: BTC, ETH, SOL)
- Watchlist CRUD API (`GET/PUT /api/watchlist`) with inline `auth()` session checks
- GET auto-creates default watchlist on first access; PUT validates with Zod (string items, max 50) and upserts
- Unit tests for Watchlist model (5 tests) with MongoMemoryServer integration
- Unit tests for watchlist API routes (10 tests): auth guards, validation, CRUD operations

- Playwright E2E test infrastructure with auth setup project pattern
- `e2e/auth.setup.ts` -- registers test user via API, logs in via UI, saves `storageState` for reuse
- Playwright config with 3 projects: `setup`, `unauthenticated`, `authenticated` (depends on setup)
- E2E auth tests (6 tests): redirect, login/register form rendering, bad credentials, nav links, full register-then-login flow
- E2E dashboard layout tests (5 tests): header, sidebar nav items, heading, watchlist section, user dropdown
- E2E dashboard feature tests (5 tests): market overview, chart container, interval tabs, watchlist symbols, add dropdown
- `e2e/.auth/` added to `.gitignore` for ephemeral session state

- Portfolio Mongoose model with embedded holdings and transactions, compound unique index `{ userId, name }`
- Portfolio types (`src/types/portfolio.ts`): Transaction, Holding, Portfolio, PortfolioListItem, API input types
- Portfolio CRUD API: GET (list with auto-create default), POST (create), PATCH (rename), DELETE (with ownership checks)
- Holdings API: POST add holding via transaction with cost basis recalculation, DELETE remove holding
- Transaction history API: GET sorted descending, POST with sell validation and holding state recalculation
- `calculateHoldingState()` pure function for weighted average cost basis including fees
- Portfolio TanStack Query hooks with optimistic updates: usePortfolios, usePortfolio, useCreatePortfolio, useRenamePortfolio, useDeletePortfolio, useAddHolding, useRemoveHolding, useRecordTransaction, useTransactions
- Portfolio page (`/portfolio`) with auto-selected first portfolio, error boundaries, and add holding button
- `PortfolioSelector` dropdown with create, rename, and delete portfolio actions
- `PortfolioSummary` cards: Total Value, Total P&L, 24h Change, connection status (live price merge pattern)
- `HoldingsList` DataTable with `@tanstack/react-table`: sorting, desktop table + mobile card stack, P&L colors
- `TransactionForm` dialog with buy/sell toggle, Zod validation, add-holding and record-transaction modes
- `TransactionHistory` dialog with buy/sell badges, date-sorted table
- Portfolio test fixtures (`src/__fixtures__/portfolio.ts`)
- E2E portfolio tests (6 tests): sidebar navigation, heading/selector, auto-created default, add holding dialog, submit holding, create second portfolio
- Unit tests for portfolio model (9), CRUD API (19), holdings API (12), transaction API (10), portfolio-utils (6), hooks (14), PortfolioSelector (6), PortfolioSummary (7), page (4), error page (2), HoldingsList (12), TransactionForm (8), TransactionHistory (5)

- `ErrorBoundary` class component with default fallback, static fallback, and render-function fallback support
- Route-level `error.tsx` for dashboard route group with centered error card and retry button
- Dashboard page wraps `MarketOverview` and `DashboardChart` in independent `ErrorBoundary` components
- Security headers in `next.config.ts`: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- Unit tests for ErrorBoundary (6 tests): children render, default fallback, reset, onError callback, static fallback, render-function fallback
- Unit tests for dashboard error page (3 tests): error message, button render, reset callback
- Unit tests for dashboard page (5 tests): heading, welcome with/without name, MarketOverview present, DashboardChart present

- Expanded price history API to support 13 intervals (added 3m, 30m, 2h, 6h, 12h, 1w, 1M) with startTime/endTime range params
- Symbol search command palette (Cmd+K) with `/api/symbols` endpoint, 1h Redis cache, client-side filtering via cmdk
- Chart type selector dropdown: Candles, Hollow, OHLC, Area modes via `chart.setStyles({ candle: { type } })`
- Indicator parameter customization panel with per-indicator settings popover (sliders + number inputs), live preview via `chart.overrideIndicator()`
- `indicator-params.ts` with parameter metadata (labels, defaults, min, max, step) for all 9 indicators
- Crosshair OHLCV legend overlay showing symbol, O/H/L/C (color-coded), volume (K/M formatted), and change %
- `ChartLegend` component with `formatPrice()` and `formatVolume()` utilities
- Fullscreen mode with native Fullscreen API and CSS fixed-position fallback
- Enhanced drawing tools: 8 tools (trendline, horizontal line, ray, extended line, horizontal ray, vertical line, Fibonacci retracement, parallel channel)
- Magnet mode toggle for drawing tool snapping (`weak_magnet` OverlayMode)
- Drawing persistence via localStorage keyed by symbol (`chart-storage.ts`: saveOverlays, loadOverlays, clearOverlays)
- Overlays auto-save on draw/move events and auto-load on symbol change
- `useSymbols` TanStack Query hook with 1h staleTime
- `SymbolSearch` component integrated into Header with search button
- shadcn/ui components: Command, Popover, ScrollArea, Slider
- Unit tests for chart-storage (10), IndicatorSettings (6), ChartLegend (10), indicator-params (9), SymbolSearch (7), useSymbols (3), symbols route (5)

- Alert Mongoose model (`src/lib/models/alert.ts`) with 6 alert types: price_above, price_below, price_change_pct, portfolio_value_above, portfolio_value_below, holding_change_pct
- Alert types (`src/types/alert.ts`): AlertType, AlertStatus unions, Alert interface, CRUD input types
- Compound indexes on `{ userId, status }` and `{ status }` for efficient querying
- Alert CRUD API: GET list with `?status=` filter, POST create with conditional Zod validation per alert type
- Alert single-resource API: GET, PATCH, DELETE with ownership enforcement
- Per-user alert limit of 50 enforced at API creation time
- `fetchTickerPrices()` Binance function for batch price fetching via `/api/v3/ticker/price?symbols=`
- Cron alert evaluator (`GET /api/cron/check-alerts`) with CRON_SECRET bearer token auth
- Price alert evaluation: fetches current prices, triggers on threshold crossing
- Portfolio value alert evaluation: calculates portfolio total value from holdings and current prices
- Holding change alert evaluation: compares current price against average buy price for P&L %
- Recurring alert support with cooldown logic (`lastTriggeredAt` + `cooldownMinutes`)
- Alert TanStack Query hooks: useAlerts, useAlert, useCreateAlert, useUpdateAlert, useDeleteAlert, useAcknowledgeAlert, useUnreadAlertCount (30s polling)
- `CreateAlertForm` dialog with Price Alert / Portfolio Alert tabs, conditional fields per subtype, recurring toggle with cooldown
- `AlertList` component with status badges (active=green, triggered=yellow, paused=gray), pause/resume/delete/acknowledge actions, loading skeletons, empty state
- Alerts management page (`/alerts`) with filter tabs (All/Active/Triggered/Paused), ErrorBoundary wrapping
- `NotificationBell` component in Header: bell icon with red unread count badge, popover with triggered alerts, dismiss/mark all read, "View All Alerts" link
- E2E tests for alerts (11 tests): sidebar navigation, page rendering, filter tabs, create alert dialog, create price alert, pause/resume, delete, notification bell visibility and popover
- Unit tests for alert model (13), alert CRUD API (16), alert single-resource API (12), cron evaluator (11), fetchTickerPrices (3), alert hooks (17), CreateAlertForm (11), AlertList (14), alerts page (3), NotificationBell (10)

- PortfolioSnapshot Mongoose model with compound unique index `{ portfolioId, date }`, pre-save date truncation to midnight UTC
- Analytics types: PortfolioSnapshot, SnapshotHolding, PortfolioHistoryPoint, TaxLot, RealizedGain, CostBasisHolding, CostBasisResult, RiskMetrics, response types
- Shared `fetchJson<T>()` utility extracted from duplicated code in usePortfolio and useAlerts hooks
- Test fixtures for analytics data (`src/__fixtures__/analytics.ts`)
- Snapshot cron endpoint (`GET /api/cron/snapshot-portfolios`) with CRON_SECRET auth, Redis dedup, batch price fetching, upsert snapshots
- FIFO cost basis engine (`src/lib/cost-basis.ts`): tax lot tracking, realized gain calculation, short/long-term holding period classification (365-day boundary), fee handling
- `computeHoldingCostBasis()` wrapper computing per-holding cost basis summary
- Risk metrics utility (`src/lib/risk-metrics.ts`): annualized volatility, max drawdown, Sharpe ratio, Sortino ratio, best/worst day, minimum data point requirements
- Analytics API routes: `/api/analytics/history`, `/api/analytics/cost-basis`, `/api/analytics/metrics` with session auth, ownership checks, Zod validation
- Analytics TanStack Query hooks: `usePortfolioHistory`, `useCostBasis`, `useRiskMetrics`, `useExportCsv` with 5min staleTime
- Portfolio value chart (`PortfolioValueChart`) using `lightweight-charts` library with area chart, range selector (7d/30d/90d/1y), crosshair tooltips, responsive resize
- Analytics dashboard page (`/analytics`) with three tabs: Overview (chart + summary cards), Cost Basis (expandable FIFO table), Risk Metrics (6 metric cards)
- `AnalyticsSummaryCards` component: Total Value, Unrealized P&L, Realized P&L, Period Return
- `CostBasisTable` component with expandable tax lot rows, total footer, Export CSV button
- `RiskMetricsCards` component: Sharpe, Sortino, Max Drawdown, Volatility, Best Day, Worst Day with insufficient data state
- Tax CSV export utility (`src/lib/csv-export.ts`): generates generic CSV (Koinly/CoinTracker compatible) with FIFO gain/loss, year filtering, holding period classification
- Tax CSV export API (`GET /api/analytics/export?portfolioId=X&year=Y`) with `text/csv` response, Content-Disposition attachment header
- E2E tests for analytics (8 tests): sidebar link, navigation, tab rendering, overview chart, cost basis table, export button, risk metrics cards, tab switching
- Unit tests for PortfolioSnapshot model (16), fetchJson (6), snapshot cron (11), FIFO engine (19), risk metrics (13), analytics API routes (18), analytics hooks (17), chart component (6), summary cards (2), cost basis table (5), risk metrics cards (3), analytics page (4), CSV export utility (14), CSV export API (9)

- Lazy-loaded chart components: `DashboardChart` and `PortfolioValueChart` via `next/dynamic` with `ssr: false` and shimmer loading placeholders
- `LazyDashboardChart` client wrapper component for server component compatibility with `next/dynamic` `ssr: false`
- Zustand selector optimization: combined 5 separate `useUIStore` selectors into single `useShallow` call in `DashboardChart`
- TanStack Query tuning: `gcTime: 10min`, `retry: 1` defaults in `QueryClient` configuration
- LIFO and HIFO cost basis methods via strategy pattern: `selectFIFO`, `selectLIFO`, `selectHIFO` lot selectors with `computeCostBasis(method, ...)` dispatcher
- `CostBasisMethod` type (`'fifo' | 'lifo' | 'hifo'`) and method selector dropdown in CostBasisTable
- Cost basis API accepts `method` query param (default: `'fifo'`)
- Koinly CSV adapter: UTC datetime format, Sent/Received Amount columns, fee fields
- CoinTracker CSV adapter: standard date format, Buy/In and Sell/Out Amount columns
- `CsvFormat` type (`'generic' | 'koinly' | 'cointracker'`) and export format dropdown in CostBasisTable
- Export API accepts `format` query param (default: `'generic'`), filename includes format name
- `aria-describedby` and `aria-invalid` on form inputs with validation errors in TransactionForm and CreateAlertForm
- `aria-label` on icon-only buttons in AlertList (Acknowledge, Pause, Resume, Delete)
- `aria-live="polite"` and `aria-busy` on loading skeletons in MarketOverview, HoldingsList, AnalyticsSummaryCards
- GitHub Actions E2E test job with Docker MongoDB 7 service container, Playwright Chromium, artifact upload on failure
- E2E tests for cost basis method selector (FIFO/LIFO/HIFO) and CSV export format dropdown (Generic/Koinly/CoinTracker)
- shadcn/ui Select component
- Unit tests for LIFO (4), HIFO (4), backward compatibility (4), method API param (2), Koinly adapter (4), CoinTracker adapter (4), generic adapter parity (1), aria attributes (6)

### Changed
- Sidebar: Analytics nav item added with BarChart3 icon, links to `/analytics`
- Sidebar: Alerts nav item enabled (was disabled with "Soon" badge), now links to `/alerts`
- Sidebar: Portfolio nav item enabled (was disabled with "Soon" badge), now links to `/portfolio`
- Dashboard page now renders `<DashboardChart />` below `<MarketOverview />` for live trading chart
- Dashboard page wraps `MarketOverview` and `DashboardChart` in `ErrorBoundary` for independent failure isolation
- Removed Step 1 demo card page (`src/app/page.tsx`), replaced by `(dashboard)/page.tsx`
- `NEXT_PUBLIC_BINANCE_WS_URL` in `.env.example` now omits `/ws` suffix (hooks append path segments as needed)
