# Technical Architecture

## 1. Project Overview

CryptoWithAlgo is a full-stack cryptocurrency portfolio management and quantitative analysis platform. It combines real-time market data from Binance, portfolio tracking with tax-lot accounting, a composite signal engine integrating 13 technical indicators with futures and sentiment data, a bar-by-bar backtesting engine with walk-forward optimization, and an automated monthly weight optimization pipeline. The system targets individual traders who want data-driven decision support without relying on opaque third-party signal providers.

### Feature Summary

| Category | Features |
|----------|----------|
| Market Data | Real-time WebSocket tickers, live candlestick charts, 24h statistics, symbol search |
| Portfolio | Multi-portfolio management, transaction ledger, FIFO/LIFO/HIFO cost basis, daily snapshots, historical performance charts |
| Signal Engine | Composite scoring across 6 categories (trend, momentum, volume, volatility, futures, sentiment), 13 technical indicators, configurable weights per trading style |
| Backtesting | Bar-by-bar simulation, 4 position sizing methods, intra-bar stop-loss/take-profit, walk-forward optimization, robustness filtering |
| Alerts | Price threshold alerts, portfolio value alerts, percentage change alerts, recurring alerts with cooldown |
| Journal | Trade journal with indicator snapshots, outcome tracking, tag-based filtering, performance analytics |
| Research | Research notes with categories and tags, news aggregation, Fear and Greed sentiment tracking |
| Optimization | Monthly automated walk-forward optimization, ensemble weight averaging, auto-activation gating |
| Analytics | Portfolio performance metrics, cost basis reporting, CSV export |

## 2. Architecture Overview

### System Topology

The platform is a monolithic Next.js application that communicates with three external services and two data stores:

```
Browser
  |
  |-- HTTPS (REST) --> Next.js App (API Routes)
  |                       |
  |                       |-- MongoDB (persistent storage, 16 collections)
  |                       |-- Upstash Redis (cache, HTTP-based)
  |                       |-- Binance REST API (market data, exchange info)
  |                       |-- Binance Futures API (funding rates, open interest, L/S ratios)
  |                       |-- CryptoPanic API (news)
  |                       |-- Alternative.me API (Fear & Greed Index)
  |
  |-- WSS (WebSocket) --> Binance WebSocket Streams (live tickers, live klines)
```

The browser establishes direct WebSocket connections to Binance for sub-second ticker and candlestick updates. All authenticated operations route through Next.js API routes, which handle database access, external API calls, and business logic.

### Monolith Decision

A single Next.js deployment handles both the UI and the API. This was a deliberate choice for a single-developer project:

- No cross-service deployment coordination
- Shared TypeScript types between client and server
- Colocated API routes alongside the pages that consume them
- Single Docker image for the entire application

The trade-off is horizontal scaling -- a monolith scales vertically or via replicas, not by independently scaling hot services. For the current user base (single-tenant, self-hosted), this is acceptable. The cron-based background jobs (signal computation, candle sync, portfolio snapshots, alert checks, monthly optimization) run as external HTTP calls to the same app, which keeps them stateless and easy to monitor.

### Directory Structure

```
src/
  app/
    (auth)/           Route group: login, register (Server Components, zero client JS)
    (dashboard)/      Route group: authenticated pages (portfolio, charts, signals, journal)
    (marketing)/      Route group: public marketing pages
    admin/            Admin panel (optimization management)
    api/              55+ API routes organized by domain
  components/         React components grouped by feature domain
  hooks/              Custom React hooks (WebSocket, market data, queries, mutations)
  lib/
    models/           16 Mongoose models with indexes and validation
    backtest/         Backtest engine, metrics, position sizing, result compression
    indicators/       Technical indicator computation and interpretation
    optimization/     Walk-forward optimizer, weight generation, ensemble, auto-activation
    signals/          Composite signal scorer
    external/         Third-party API clients (CryptoPanic, Fear & Greed)
  stores/             Zustand client-side stores
  types/              TypeScript type definitions and Zod schemas
  test/               Test setup, utilities, mock WebSocket
  __fixtures__/       Shared test data
  __mocks__/          Module-level mocks
e2e/                  Playwright end-to-end tests
docker/               Caddyfile, crontab template, mongo init script, cron entrypoint
```

Route groups `(auth)`, `(dashboard)`, and `(marketing)` use Next.js layout nesting to apply different layouts (sidebar vs. minimal) without affecting URL paths. Auth pages are Server Components with no client-side JavaScript -- the only JS on those pages comes from the form submission handlers.

### Data Flow

**Read path (REST)**:
Browser -> Next.js API Route -> auth check (JWT decode) -> MongoDB query (Mongoose) -> JSON response

**Read path (cached)**:
Browser -> API Route -> Redis GET (cache hit) -> JSON response
Browser -> API Route -> Redis GET (miss) -> compute/fetch -> Redis SET with TTL -> JSON response

**Write path**:
Browser -> API Route -> Zod validation -> Mongoose model operation -> MongoDB write -> JSON response

**Real-time path**:
Binance WSS -> Browser WebSocket -> React hook -> RAF batch -> React state -> Component render -> KlineCharts update

## 3. Technology Decisions

### 3a. Next.js 16 (App Router)

**What**: Full-stack React framework with file-system routing, Server Components, and built-in API routes.

**Why chosen**:

- **Server Components** eliminate client JavaScript for pages that don't need interactivity. The auth pages (login, register) and marketing pages are fully server-rendered. Only the dashboard pages with real-time data ship client bundles.
- **API routes colocated with the app** remove the need for a separate backend. The 55+ API routes live under `src/app/api/`, organized by domain (portfolio, signals, backtests, cron, admin). A separate Express or Fastify server would add deployment complexity with no architectural benefit for this use case.
- **Middleware** gates authentication at the edge. The middleware checks for a session cookie and redirects unauthenticated users to `/login`, avoiding full page loads for unauthorized requests.
- **Standalone Docker output** (`output: 'standalone'` in `next.config.ts`) produces a self-contained `server.js` that bundles only the dependencies actually imported. The production Docker image contains ~100MB instead of the full 500MB+ `node_modules/`.

**Alternatives considered**:

| Alternative | Reason not chosen |
|-------------|-------------------|
| Remix | Smaller ecosystem for auth adapters and charting libraries at the time of development |
| Vite + Express | Two separate deployments, duplicated type definitions, no server component support |
| SvelteKit | Would require rewriting all component logic; React ecosystem has more charting and financial data libraries |

**Trade-off**: The Next.js monolith means the charting library, backtesting engine, and admin panel all ship in the same Docker image. For a microservices architecture, the backtesting engine could scale independently. But for a single-developer project, the operational simplicity of one deployment pipeline outweighs the scaling flexibility of multiple services.

### 3b. MongoDB + Mongoose

**What**: Document database with Mongoose as the ODM layer, providing schema validation, middleware, and type-safe queries.

**Why chosen**:

The data model is heavily nested and heterogeneous. A portfolio contains holdings, each holding contains transactions, each transaction has different fields depending on whether it's a buy or sell. A backtest result contains a metrics object, a trade summary, and a sampled equity curve (up to 200 data points). A signal contains 6 component objects, each with a nested array of individual signal observations.

These structures map directly to MongoDB documents without the impedance mismatch of normalizing into relational tables. Specific advantages:

- **Schema flexibility**: Journal entries gained 5 new fields over 12 development phases (setupType, marketCondition, sentiment, strategyId, backtestResultId). With MongoDB, adding fields required no migrations -- existing documents simply don't have the new fields until updated.
- **Nested arrays of mixed types**: Indicator snapshots stored on journal entries are arbitrary JSON objects (RSI values, MACD histograms, Bollinger Band widths). Backtest equity curves are arrays of `{timestamp, equity}` pairs. These fit naturally as embedded documents.
- **No JOIN-heavy access patterns**: The application reads one portfolio at a time, one signal at a time, one backtest at a time. There are no cross-collection aggregation queries that would benefit from relational JOINs. The only "join" is fetching a user's portfolios, which is a simple `userId` filter.

**Indexing strategy (16 collections)**:

| Index Type | Count | Examples |
|------------|-------|---------|
| Compound | 20+ | `(userId, createdAt)` for user-scoped time-ordered queries; `(symbol, interval, timestamp)` for candle lookups |
| Unique | 5 | `User.email`; `Portfolio(userId, name)`; `Candle(symbol, interval, timestamp)`; `Watchlist.userId`; `PortfolioSnapshot(portfolioId, date)` |
| TTL | 2 | `Signal.createdAt` expires after 90 days; `HistoricalSnapshot.createdAt` expires after 1 year |
| Single field | 6 | `Alert.status` for cron-based alert scanning |

TTL indexes handle automatic data expiry without application logic. Signals older than 90 days and historical market snapshots older than 1 year are garbage-collected by MongoDB's background TTL thread.

**Why not PostgreSQL**: The primary data access pattern is "fetch one document by ID or by userId + timestamp range." There are no multi-table JOINs, no transactions spanning multiple entities, and no need for ACID guarantees across collections. The nested document structure (portfolios with holdings with transactions, signals with components with individual observations) would require 3-4 normalized tables each, adding query complexity without performance benefit. PostgreSQL's JSONB columns could store the nested data, but at that point the relational model provides no advantage over a document store.

### 3c. NextAuth.js v5 (Authentication)

**What**: Authentication library for Next.js with built-in support for credentials, OAuth providers, and database adapters.

**Why chosen**:

- **JWT session strategy**: Sessions are encoded in a signed JWT stored as an HTTP-only cookie. No session table lookups on every request. The middleware can check for cookie existence without any database call -- cryptographic verification happens only in API routes that call `auth()`.
- **Credentials + OAuth**: Users can register with email/password (hashed with bcryptjs, 10 salt rounds) or sign in with Google/GitHub. The MongoDBAdapter handles OAuth account linking -- if a user registers with email and later signs in with Google using the same email, the accounts are linked automatically.
- **Minimal attack surface**: Passwords are never stored in plaintext. JWT tokens are signed with NEXTAUTH_SECRET. The middleware uses cookie-based session detection without importing Node.js crypto (which is incompatible with the edge runtime).

**Session strategy trade-off**:

| Aspect | JWT (chosen) | Database Sessions |
|--------|-------------|-------------------|
| Latency | No DB lookup per request | DB read per request |
| Revocation | Cannot revoke individual sessions without a blocklist | Immediate revocation by deleting session row |
| Serverless | Stateless, works everywhere | Requires persistent DB connection |
| Payload | Grows with claims; limited by cookie size | Fixed-size session ID |

JWT was chosen because the application is deployed as a serverless-compatible Docker container. Database sessions would require a persistent connection pool or a separate session store. Since the application has no requirement for immediate session revocation (no admin panel for force-logging-out users), the simpler JWT approach is appropriate.

### 3d. WebSocket Real-Time Pipeline

**What**: Direct browser-to-Binance WebSocket connections for live market data, with React hooks managing connection lifecycle, reconnection, and render batching.

**Architecture**:

```
Binance WSS
    |
    v
useWebSocket (generic hook)
    |-- reconnection with exponential backoff
    |-- multi-handler subscription pattern
    |
    v
useBinanceTicker (combined multi-symbol stream)
    |-- RAF batching for high-frequency updates
    |-- coalesces updates into single setState
    |
    v
useBinanceKline (single symbol stream)
    |-- feeds into KlineCharts DataLoader subscribeBars callback
```

**Reconnection logic** (in `useWebSocket`):
- Initial delay: 3 seconds
- Backoff formula: `delay = 3000 * 2^attempt` (3s, 6s, 12s, 24s, 48s...)
- Maximum attempts: 10 for Binance streams
- Safety: `mountedRef` flag prevents reconnection after component unmount
- Reset: Attempt counter resets to 0 on successful connection

**RequestAnimationFrame batching** (in `useBinanceTicker`):

Binance combined ticker streams can produce 50-100+ messages per second when watching 10+ symbols. Without batching, each message would trigger a React state update and re-render.

The batching solution:
1. Incoming messages write to a `pendingUpdatesRef` (a plain object, not React state)
2. The first message in a frame schedules a `requestAnimationFrame` callback
3. Subsequent messages in the same frame accumulate in the ref without scheduling another RAF
4. When the RAF fires (~16ms later), all pending updates flush into a single `setTickers()` call
5. Result: 100 messages/second become ~60 state updates/second (one per frame), each containing all symbol updates since the last frame

**Trade-off: WebSocket vs polling**: Live trading charts require sub-second price updates. Polling at 1-second intervals would introduce 0.5-1 second average latency and generate 3,600 HTTP requests per hour per symbol. WebSocket provides true push semantics with a single persistent connection per stream type.

### 3e. Binance API Integration

**What**: REST API for historical and snapshot data; WebSocket for live streaming.

**REST endpoints used**:

| Endpoint | Data | Usage |
|----------|------|-------|
| `/api/v3/ticker/24hr` | 24h ticker statistics | Dashboard market overview |
| `/api/v3/klines` | Historical OHLCV candles | Chart initialization, backtest data |
| `/api/v3/exchangeInfo` | Trading pairs, status | Symbol search and validation |
| `/api/v3/ticker/price` | Current prices by symbol | Cron alert evaluation, portfolio valuation |
| `/fapi/v1/fundingRate` | Perpetual futures funding rates | Signal engine futures component |
| `/fapi/v1/openInterest` | Current open interest | Futures data panel |
| `/futures/data/openInterestHist` | Historical open interest | Futures charts |
| `/futures/data/topLongShortPositionRatio` | Top trader L/S ratios | Signal engine futures component |
| `/futures/data/globalLongShortAccountRatio` | Global account L/S ratios | Futures data panel |

**WebSocket streams**:

| Stream | URL Pattern | Usage |
|--------|-------------|-------|
| Combined ticker | `/stream?streams=btcusdt@ticker/ethusdt@ticker/...` | Watchlist real-time prices |
| Kline | `/ws/{symbol}@kline_{interval}` | Live chart candle updates |

**Rate-limited paginated backfill**: The candle backfill system (`fetchKlinesRange`) fetches up to 1000 candles per page with a 200ms delay between pages to stay within Binance's rate limits. The candle ingestion layer (`bulkUpsertCandles`) uses MongoDB `bulkWrite` with `updateOne` + `upsert: true` to deduplicate by `(symbol, interval, timestamp)`, making the ingestion idempotent -- the same candle fetched twice overwrites itself rather than creating a duplicate.

**Geo-restriction handling**: Binance REST API returns HTTP 403 from US IP addresses. The `BINANCE_API_URL` and `BINANCE_FUTURES_API_URL` environment variables allow pointing the server-side client at a proxy or alternative endpoint. The client-side WebSocket URL is configurable via `NEXT_PUBLIC_BINANCE_WS_URL`.

### 3f. Upstash Redis (Caching Layer)

**What**: HTTP-based Redis client that works in serverless and edge environments without persistent TCP connections.

**Implementation** (`src/lib/redis.ts`):

The entire caching layer is 43 lines of code. The `cachedFetch<T>` function implements cache-aside:

1. Check `redis.get(key)` -- return cached value on hit
2. On miss or Redis error, call the `fetcher()` function
3. Store result with `redis.set(key, data, { ex: ttlSeconds })`
4. Return data regardless of whether the cache write succeeded

**Graceful degradation at three levels**:

| Failure Mode | Behavior |
|-------------|----------|
| Redis env vars missing | `redis` is `null`; `cachedFetch` calls `fetcher()` directly |
| `redis.get()` throws | Caught silently; falls through to `fetcher()` |
| `redis.set()` throws | Caught silently; data is still returned to caller |

The application never fails because Redis is unavailable. It just runs slower (every request hits the upstream data source).

**TTLs by data type**:

| Data | TTL | Rationale |
|------|-----|-----------|
| Crypto news | 5 minutes | News doesn't change frequently; avoid rate-limiting CryptoPanic |
| Fear & Greed Index | 5 minutes | Updated hourly by Alternative.me; 5-min TTL is conservative |
| Ticker prices (cron) | 30 seconds | Cron alert checks need reasonably fresh prices without hammering Binance |

**Why Upstash over self-hosted Redis**: Serverless functions are stateless -- each invocation starts with no in-memory state. A traditional Redis client requires a TCP connection pool, which doesn't work when the "server" is a short-lived function. Upstash's HTTP-based client sends each command as an HTTP request, eliminating connection management entirely. The trade-off is slightly higher per-operation latency (~5ms HTTP vs ~1ms TCP), which is negligible for a caching layer that saves 100-500ms API calls.

### 3g. Signal Computation Engine

**What**: A composite scoring system that combines 13 technical indicators, Binance futures data, and market sentiment into a single -100 to +100 score with confidence weighting.

**Architecture**:

```
OHLCV Candles
    |
    v
computeAllIndicators()     -- 13 indicators computed once
    |
    v
interpretIndicators()      -- each indicator produces direction + strength signals
    |
    v
computeSignalScore()       -- 6 categories scored and weighted
    + FuturesData (optional)
    + SentimentData (optional)
    + SignalWeights (configurable per strategy)
    |
    v
CompositeSignal { score: -100..+100, tier, confidence: 0..100, components[] }
```

**Technical indicators (13 total)**:

| Category | Indicators | Interpretation |
|----------|-----------|----------------|
| Trend | EMA(12), EMA(26), SMA(50), SMA(200), Ichimoku Cloud, SuperTrend | EMA crossover spread, golden/death cross, price position relative to cloud and SuperTrend direction |
| Momentum | RSI(14), MACD(12,26,9), Stochastic RSI(14), Williams %R | Overbought/oversold levels, histogram direction, K/D crossovers |
| Volatility | Bollinger Bands(20,2), ATR(14) | %B position within bands, volatility as percentage of price |
| Volume | OBV, MFI(14), Volume Ratio (current/SMA20) | OBV vs its 20-period SMA, MFI overbought/oversold, volume spike detection |

**Default weight distribution**:

| Category | Weight | Data Source |
|----------|--------|-------------|
| Trend | 25% | OHLCV candles (always available) |
| Momentum | 25% | OHLCV candles (always available) |
| Volume | 15% | OHLCV candles (always available) |
| Volatility | 10% | OHLCV candles (always available) |
| Futures | 15% | Binance Futures API (may be unavailable) |
| Sentiment | 10% | CryptoPanic + Alternative.me (may be unavailable) |

**Dynamic weight redistribution**: When a data source is unavailable (e.g., futures data returns an error), its weight is redistributed proportionally to the remaining categories. If futures (15%) is missing, the available weight pool is 85%, and each remaining category's weight is divided by 0.85. Trend becomes 25/85 = 29.4%, momentum 29.4%, etc. The signal score is never penalized for missing external data -- it simply relies more heavily on technical analysis.

**Contrarian interpretation**: Futures and sentiment data use contrarian logic:

- **Funding rate**: Extreme positive funding (longs paying shorts) is bearish -- the market is overleveraged long. Extreme negative funding is bullish.
- **Long/short ratio**: Ratio above 2.0 (heavily long) is bearish. Below 0.5 (heavily short) is bullish.
- **Fear & Greed**: Extreme fear (index below 10) is bullish -- the market has likely overreacted. Extreme greed (above 90) is bearish.

**Confidence scoring**: Starts at 100% and decreases by the weight percentage of each missing data source. With all data: 100%. Missing futures: 85%. Missing sentiment: 90%. Missing both: 75%.

**Tier assignment**:

| Score Range | Tier |
|-------------|------|
| > 60 | Strong Buy |
| > 30 | Buy |
| -30 to 30 | Neutral |
| < -30 | Sell |
| < -60 | Strong Sell |

**Why build custom**: No existing library combines technical indicators, futures derivatives data, and news sentiment into a unified scoring system with configurable weights per trading style. Libraries like `technicalindicators` compute raw indicator values, but the interpretation layer (what RSI=75 means in the context of a trending market with extreme funding rates) is domain-specific.

### 3h. Backtesting Engine

**What**: A bar-by-bar simulation engine that replays historical candle data through the signal engine, executes trades based on configurable thresholds, and computes comprehensive performance metrics.

**Simulation loop** (simplified):

```
Pre-compute all indicators for the entire candle series (once)
Pre-compute SuperTrend for the entire series (once)
Determine warmup bars (~100 bars for indicator stabilization)

for each bar from warmup to end:
    if open position exists:
        check stop-loss against candle low (long) / high (short)
        check take-profit against candle high (long) / low (short)
        if either triggered: close trade at trigger price

    compute signal score using pre-computed indicators at this bar

    if open position exists and signal crosses exit threshold:
        close trade at candle close price

    if no position and signal crosses entry threshold:
        open position at candle close price with computed position size

    record equity curve data point

close any open position at end of data
compute metrics from trade list and equity curve
```

**Key design decisions**:

- **Pre-computed indicators**: The `prepareBacktest()` function computes all 13 indicators and SuperTrend once for the entire candle series. During walk-forward optimization, this allows testing 50 different weight configurations per window without recomputing indicators each time. Only the `computeSignalScore()` call (which is a weighted sum) changes between candidates.

- **Intra-bar stop-loss/take-profit**: Stop and take-profit levels are checked against the candle's high and low, not just the close. This prevents the unrealistic scenario where a candle's low dips below the stop loss but closes above it -- in reality, the stop would have been triggered during the bar. Long positions check `candle.low <= stopPrice` and `candle.high >= takeProfitPrice`. Short positions check the inverse.

- **Execution order**: Stop-loss/take-profit checks happen before signal-based exit checks within the same bar. This models the real-world priority of protective orders over discretionary exits.

**Position sizing methods**:

| Method | Formula | When to use |
|--------|---------|-------------|
| Fixed Percent | `equity * positionSizePercent / entryPrice` | Simple baseline; always works |
| Fixed Fractional | `(equity * riskPerTrade) / abs(entry - stopLoss)` | Risk-normalized sizing; standard for systematic trading |
| Kelly Criterion | `((winRate * avgWin/avgLoss) - (1 - winRate)) / (avgWin/avgLoss)` scaled by `fractionKelly` (default 0.5 for half-Kelly) | Mathematically optimal sizing; requires 5+ completed trades for win rate estimation |
| Risk-Based | Same as Fixed Fractional | Alias with different config naming convention |

Kelly criterion falls back to fixed percent when fewer than 5 trades have completed, since the win rate estimate is unreliable with small samples. Half-Kelly (0.5 multiplier) is the default to reduce the aggressive sizing that full Kelly produces.

**Performance metrics computed**:

| Metric | Formula |
|--------|---------|
| Sharpe Ratio | `(mean_return / stddev_returns) * sqrt(252)` (annualized) |
| Sortino Ratio | `(mean_return / downside_stddev) * sqrt(252)` (only negative returns in denominator) |
| Calmar Ratio | `total_pnl_percent / max_drawdown_percent` |
| Max Drawdown | Peak-to-trough equity decline (absolute and percentage) |
| Profit Factor | `gross_profits / gross_losses` |
| Win Rate | `winning_trades / total_trades` |
| Average Win/Loss | Mean P&L of winning/losing trades (absolute and percentage) |
| Max Consecutive Wins/Losses | Longest win and loss streaks |
| Total Fees | Sum of all trade fees |

**Trade-off: simplicity vs realism**: The engine does not model slippage, order book depth, or partial fills. This is acceptable for the target use case (swing trading on 1h-4h timeframes with major pairs like BTCUSDT), where slippage on market orders is typically under 0.1%. A high-frequency trading engine would require tick-level simulation and order book modeling.

### 3i. Walk-Forward Optimization

**What**: An anchored expanding-window optimization process that tests weight configurations on training data and validates them on out-of-sample test data, preventing overfitting to historical patterns.

**Algorithm**:

```
Anchored expanding window:

Window 1: Train [0 .. 299]     Test [300 .. 399]
Window 2: Train [0 .. 599]     Test [600 .. 699]
Window 3: Train [0 .. 899]     Test [900 .. 999]
...

Training window always starts at bar 0 and expands by stepSizeBars each iteration.
Test window is a fixed size (100 bars) immediately after training.
```

**Per-window process**:

1. **Generate 50 weight candidates**: First candidate is the base weights (unmodified). Remaining 49 are randomly generated with a +/-20% constraint from the base, normalized to sum to 1.0. A seeded LCG random number generator ensures reproducible results.

2. **Test all candidates on training data**: Each candidate uses the pre-computed indicators (computed once per window) with different weights in the signal scorer. This is the performance optimization that makes 50 backtests per window feasible.

3. **Robustness filter**: Discard candidates that don't meet minimum thresholds: Sharpe >= 0.5, win rate >= 40%, max drawdown <= 30%, at least 10 trades.

4. **Validate best candidate**: Run the top performer (by Sharpe ratio) on the out-of-sample test window. Record the test Sharpe.

5. **Ensemble selection**: After all windows, take the top 5 by test Sharpe ratio. Average their weight sets to produce the final optimized weights. This ensemble approach reduces variance from any single window's results.

**Auto-activation gate**: Optimized weights are not automatically applied. The gate requires:
- At least 5 valid backtest results in the ensemble
- The optimized Sharpe ratio must exceed the current active template's Sharpe by at least 10%
- If no current template exists, the first optimization result is activated automatically
- The decision and reasoning are logged on the CronRun record for auditability

**Trade-off: monthly batch vs real-time optimization**: The optimization runs monthly as a cron job rather than continuously adapting weights. Monthly batches are predictable (you know when they run), debuggable (you can inspect the CronRun record), and resistant to overfitting to recent data. Continuous optimization risks chasing noise in short-term market microstructure.

### 3j. News and Sentiment Analysis

**What**: Aggregated crypto news from CryptoPanic with keyword-based sentiment scoring, combined with the Alternative.me Fear & Greed Index, fed into the signal engine as a weighted component.

**News pipeline**:
1. Fetch top 20 articles from CryptoPanic's `/api/free/v1/posts/` endpoint
2. Cache response in Redis with 5-minute TTL
3. Score each article title using keyword matching: 12 bullish keywords (+0.3 each) and 13 bearish keywords (-0.3 each), clamped to [-1, +1]
4. Compute batch statistics: article count, average sentiment, extracted topic tags
5. Feed average sentiment into the signal engine's sentiment component

**Keyword lists**:
- Bullish: rally, surge, gain, rise, bull, breakout, adoption, institutional, etf approved, upgrade, partnership, launch
- Bearish: crash, fall, drop, decline, bear, sell-off, regulation, ban, hack, scam, fraud, lawsuit, investigation

**Fear & Greed Index**: Fetched from Alternative.me, cached 5 minutes. The index (0-100) is interpreted using contrarian logic in the signal scorer: extreme fear (below 10) produces a bullish signal, extreme greed (above 90) produces a bearish signal.

**Trade-off: keyword matching vs ML**: Keyword matching is simple, transparent, and debuggable. Since sentiment carries only 10% weight in the composite signal, the marginal accuracy improvement from ML-based NLP (fine-tuned BERT, GPT-based classification) would have minimal impact on the final signal score. The engineering effort and inference cost of an ML pipeline are not justified for a 10% weight component.

## 4. Data Architecture

### Collections and Relationships

```
User
  |-- Portfolio (1:N)
  |     |-- PortfolioSnapshot (1:N, daily snapshots)
  |
  |-- Alert (1:N)
  |-- Watchlist (1:1)
  |-- JournalEntry (1:N, max 1000 per user)
  |-- ResearchNote (1:N, max 200 per user)
  |-- Signal (1:N, TTL 90 days)
  |-- Strategy (1:N, max 5 per user)
  |     |-- BacktestResultV2 (1:N)
  |     |-- BacktestResult (1:N, legacy)
  |
  |-- SignalTemplate (referenced by Strategy, BacktestResultV2)

OptimizationJob (standalone, references BacktestResultV2 via ensemble)
CronRun (standalone, references OptimizationJob)
Candle (standalone market data, unique on symbol+interval+timestamp)
HistoricalSnapshot (standalone, TTL 1 year)
```

### Cost Basis Computation

The system implements three tax-lot accounting methods:

| Method | Lot Selection Strategy |
|--------|----------------------|
| FIFO (First In, First Out) | Sells the earliest purchased lot first |
| LIFO (Last In, First Out) | Sells the most recently purchased lot first |
| HIFO (Highest In, First Out) | Sells the lot with the highest cost basis first (tax-optimal for gains) |

Each sell transaction consumes lots from the open lot queue according to the selected method. Partially consumed lots track their remaining quantity. Realized gains record the buy date, sell date, quantity, proceeds, cost basis, and holding period (short-term vs long-term based on 1-year threshold).

### Portfolio Snapshot System

A daily cron job (`/api/cron/snapshot-portfolios`) captures the current value of each user's portfolio holdings using live Binance prices. Snapshots are stored with a unique constraint on `(portfolioId, date)` truncated to midnight UTC, ensuring one snapshot per day per portfolio. These snapshots power the portfolio performance chart and historical analytics.

## 5. Real-Time Data Pipeline

### Data Flow Detail

```
Binance Combined Stream (wss://stream.binance.com:9443/stream?streams=...)
    |
    v
Browser WebSocket (native)
    |
    v
useBinanceTicker hook
    |-- parse JSON message
    |-- write to pendingUpdatesRef (no React state, no re-render)
    |-- schedule requestAnimationFrame (if not already scheduled)
    |
    v
RAF callback fires (~60fps)
    |-- read all pending updates from ref
    |-- clear ref
    |-- single setTickers() call with all updates
    |
    v
React re-render (once per frame, not once per message)
    |
    v
Watchlist table, portfolio values, alert evaluation
```

### KlineCharts v10 DataLoader

KlineCharts v10 replaced the imperative `applyNewData()`/`updateData()` API with a declarative DataLoader pattern:

```
chart.setDataLoader({
    getBars(params):
        fetch 500 historical candles from /api/prices/history
        transform to KLineData format
        callback(bars, hasMoreData=false)

    subscribeBar(params):
        open WebSocket to Binance kline stream for symbol+interval
        on each message: callback(newCandleData)

    unsubscribeBar():
        close WebSocket connection
})
```

The `getBars` callback loads historical data on chart initialization or timeframe change. The `subscribeBars` callback establishes a live WebSocket connection that pushes each new candle update directly into the chart. When the user changes the timeframe, `unsubscribeBar` closes the current WebSocket before `subscribeBars` opens a new one for the new interval.

## 6. Testing Strategy

### Unit Tests (1,878 tests across 215 files)

**Framework**: Vitest + Testing Library

**Coverage areas**:

| Area | What's tested | Approach |
|------|--------------|----------|
| React components | Rendering, user interaction, conditional display | Testing Library with screen queries, fireEvent, waitFor |
| Custom hooks | State management, WebSocket behavior, data fetching | renderHook with act() wrappers |
| API routes | Request/response, validation, auth checks, error handling | Direct function calls with mocked NextRequest/NextResponse |
| Mongoose models | Schema validation, index definitions, defaults | Model instantiation with mongodb-memory-server |
| Business logic | Signal scoring, backtest engine, cost basis, metrics | Pure function tests with fixture data |
| Utilities | CSV export, date formatting, number formatting | Pure function tests |

**Mocking strategy**:

| Dependency | Mock approach |
|-----------|--------------|
| Binance REST | `vi.mock('@/lib/binance')` returning fixture data |
| WebSocket | `MockWebSocket` class simulating open/message/close/error events |
| MongoDB | `mongodb-memory-server` for integration tests; `vi.mock` for unit tests |
| Redis | Module mock returning `null` (simulates Redis-unavailable path) |
| NextAuth | `vi.mock('next-auth')` and `vi.mock('next-auth/react')` to avoid `next/server` import in Node test environment |
| next/navigation | `vi.mock('next/navigation')` providing `useRouter`, `useSearchParams`, `usePathname` |

### E2E Tests (91 tests across 10 spec files)

**Framework**: Playwright with a setup project pattern

**Auth setup**: A dedicated `auth.setup.ts` Playwright project runs before all authenticated tests. It registers a test user via the `/api/auth/register` endpoint, logs in through the UI, and saves the browser storage state to `e2e/.auth/user.json`. Authenticated test projects depend on the setup project and reuse the saved session.

**Spec files**:

| File | Scope | Auth |
|------|-------|------|
| `auth.setup.ts` | User registration + login | None (creates auth) |
| `auth.spec.ts` | Login/register page rendering, redirects | Unauthenticated |
| `dashboard-layout.spec.ts` | Header, sidebar, navigation | Authenticated |
| `dashboard.spec.ts` | Market overview, chart, watchlist | Authenticated |
| `portfolio.spec.ts` | Portfolio CRUD, holdings | Authenticated |
| `analytics.spec.ts` | Analytics dashboard, cost basis | Authenticated |
| `signals.spec.ts` | Signal display, strategy management | Authenticated |
| `journal.spec.ts` | Journal entries, filtering | Authenticated |
| `marketing.spec.ts` | Public pages, feature showcase | Unauthenticated |
| `optimization.spec.ts` | Cron history, admin panel | Authenticated |

**E2E environment**: Requires Docker MongoDB (`docker-compose up -d`). Binance REST API may return 403 from US IPs, so market data tests accept either a loaded state or a loading/error state.

### Per-Step CI Checklist

Every code change follows this checklist before committing:

1. `npm run lint` -- zero ESLint errors
2. `npm run typecheck` -- zero TypeScript errors
3. `npm run test` -- all unit tests pass
4. `npm run build` -- clean production build
5. `npm run test:e2e` -- all E2E tests pass
6. Conventional commit message

## 7. Deployment

### Docker Multi-Stage Build

The Dockerfile uses three stages to minimize the production image:

| Stage | Base | Purpose | What's copied forward |
|-------|------|---------|----------------------|
| `deps` | node:22-alpine | Install npm dependencies | `node_modules/` |
| `builder` | node:22-alpine | Compile TypeScript, build Next.js | `.next/standalone/`, `.next/static/`, `public/` |
| `runner` | node:22-alpine | Production runtime | Standalone server + static assets |

The production image runs as a non-root user (`nextjs`, uid 1001) and includes a health check that hits `http://127.0.0.1:3000/api/health` (using `127.0.0.1` instead of `localhost` because Alpine's DNS resolves `localhost` to IPv6 `::1` first, but Next.js binds IPv4 only).

### Container Orchestration

```
docker-compose.prod.yml:

  caddy (reverse proxy)
    |-- ports: 80, 443
    |-- automatic HTTPS via Let's Encrypt
    |-- reverse_proxy -> app:3000
    |
  app (Next.js)
    |-- standalone server.js
    |-- depends_on: mongodb (healthy)
    |-- health check: /api/health
    |
  mongodb
    |-- mongo:7 with init script for app user
    |-- persistent volume: mongodb_prod_data
    |
  cron (Alpine + wget)
    |-- crontab with 4 scheduled jobs
    |-- depends_on: app
```

### Cron Jobs

| Schedule | Endpoint | Purpose |
|----------|----------|---------|
| Every 5 minutes | `/api/cron/check-alerts` | Evaluate price alerts against current prices |
| Every 10 minutes | `/api/cron/compute-signals` | Recompute trading signals for active strategies |
| Every 15 minutes | `/api/cron/sync-candles` | Incrementally sync candle data for watched symbols |
| Daily at midnight | `/api/cron/snapshot-portfolios` | Capture daily portfolio value snapshots |

All cron requests include a `Bearer` token (`CRON_SECRET`) that the API routes validate before processing. The cron container is a minimal Alpine image with `wget` that calls the Next.js API endpoints over the internal Docker network.

### Health Endpoint

The `/api/health` endpoint returns:

```json
{
  "status": "ok",
  "timestamp": "2026-02-14T00:00:00.000Z",
  "uptime": 86400.5,
  "mongodb": "connected"
}
```

It explicitly calls `connectDB()` because Next.js standalone mode uses lazy MongoDB connections -- without an active connection trigger, `mongoose.connection.readyState` would remain 0 (disconnected) indefinitely. If MongoDB is unreachable, the endpoint returns HTTP 503 with `"status": "degraded"`.
