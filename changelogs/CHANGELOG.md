# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Public marketing landing page at `/` with LandingNav, HeroSection, FeaturesSection, StatsSection, CTASection, and Footer
- Marketing route group `(marketing)` with bare layout
- Animated mock price ticker on hero section (BTC, ETH, SOL, BNB)
- CSS animations: `animate-float` and `animate-fade-in-up` for landing page
- Auth page branding: grid pattern background, radial gradient glow, Star icon header
- Landing page E2E tests (6 tests in `e2e/landing.spec.ts`)
- Unit tests for all marketing components (17 tests across 5 test files)

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
