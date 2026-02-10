# CryptoWithAlgo -- Project Documentation

## Table of Contents

1. [Project Overview](#project-overview)
2. [Signal Algorithm](#signal-algorithm)
3. [Backtesting Engine](#backtesting-engine)
4. [Trading Journal](#trading-journal)
5. [Portfolio Management](#portfolio-management)
6. [Analytics System](#analytics-system)
7. [Alerts System](#alerts-system)
8. [Architecture](#architecture)

## Project Overview

CryptoWithAlgo is a real-time cryptocurrency portfolio tracker and signal analysis platform. It combines live market data from Binance with a multi-indicator technical analysis engine, a bar-by-bar backtesting simulator, portfolio tracking with tax-lot cost basis, risk analytics, and a configurable alerts system.

### Core Capabilities

- **Signal Generation**: 14+ technical indicators across trend, momentum, volume, volatility, and futures categories, scored into actionable tiers (strong buy through strong sell).
- **Backtesting**: Bar-by-bar simulation engine with configurable position sizing (fixed percent, fractional, Kelly criterion), stop-loss/take-profit, short selling, and comprehensive performance metrics.
- **Portfolio Management**: Multi-portfolio holdings tracking with buy/sell transactions, average cost basis, and real-time P&L via Binance prices.
- **Analytics**: Daily portfolio snapshots, annualized risk metrics (Sharpe, Sortino, max drawdown), and tax-lot cost basis (FIFO/LIFO/HIFO) with CSV export (generic, Koinly, CoinTracker).
- **Alerts**: Six alert types (price, portfolio value, holding change) with cooldown periods, recurring alerts, and cron-based evaluation.
- **Journal**: Trading decision log for recording signals, actions taken, and realized outcomes.
- **Real-Time Data**: Binance WebSocket streams for live ticker and kline updates.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, TypeScript) |
| Auth | NextAuth.js v5 (credentials + Google/GitHub OAuth) |
| Database | MongoDB 7 (Mongoose ODM) |
| Cache | Upstash Redis (HTTP-based, serverless-compatible) |
| Client State | Zustand |
| Server State | TanStack React Query |
| Charts | KlineCharts v10 |
| UI | shadcn/ui (New York style), Tailwind CSS v4 |
| Validation | Zod v4 |
| Real-Time | Binance WebSocket streams |
| Testing | Vitest + Testing Library + Playwright |

## Signal Algorithm

The signal system evaluates market conditions across five indicator categories, producing a composite score from -100 (extreme bearish) to +100 (extreme bullish).

### Technical Indicators

#### Trend Indicators

| Indicator | Parameters | Bullish Signal | Bearish Signal |
|-----------|-----------|----------------|----------------|
| EMA Cross | Fast 12 / Slow 26 | EMA12 > EMA26 | EMA12 < EMA26 |
| SMA Cross | 50 / 200 | Golden Cross (SMA50 > SMA200) | Death Cross (SMA50 < SMA200) |
| Ichimoku Cloud | Conversion 9, Base 26, Span 52, Displacement 26 | Price above cloud, Tenkan > Kijun | Price below cloud, Tenkan < Kijun |
| SuperTrend | ATR-based | Price above SuperTrend line | Price below SuperTrend line |

#### Momentum Indicators

| Indicator | Parameters | Bullish Signal | Bearish Signal |
|-----------|-----------|----------------|----------------|
| RSI | 14-period | Oversold: <=30 (extremely <=20) | Overbought: >=70 (extremely >=80) |
| MACD | 12/26/9 | Positive histogram, rising | Negative histogram, falling |
| Stochastic RSI | 14/14/3/3 | K,D < 20 (oversold) | K,D > 80 (overbought) |
| Williams %R | 14-period | < -80 (oversold) | > -20 (overbought) |

#### Volatility Indicators

| Indicator | Parameters | Interpretation |
|-----------|-----------|----------------|
| Bollinger Bands | Period 20, StdDev 2 | %B > 1.0 = above upper band; %B < 0.0 = below lower band |
| ATR | 14-period | > 5% of price = high volatility; 3-5% = moderate; < 3% = low |

#### Volume Indicators

| Indicator | Parameters | Interpretation |
|-----------|-----------|----------------|
| OBV | 20-period SMA | Current OBV vs 20-period average |
| MFI | 14-period | >= 80 overbought; <= 20 oversold |
| Volume Ratio | 20-period SMA | Ratio > 2.0 = high activity; < 0.5 = low activity |

#### Futures Market Data

| Indicator | Interpretation |
|-----------|----------------|
| Funding Rate | Contrarian: negative = shorts pay longs (bullish); positive = longs pay shorts (bearish). Thresholds: -0.001 very bullish, +0.001 very bearish |
| Long/Short Ratio | Contrarian: ratio > 2.0 = heavily long (bearish); ratio < 0.5 = heavily short (bullish) |

### Scoring and Weighting

Each indicator returns a direction (bullish/bearish/neutral) and strength (0-100). Indicators are grouped by category with default weights:

| Category | Default Weight |
|----------|---------------|
| Trend | 25% |
| Momentum | 25% |
| Volume | 15% |
| Volatility | 10% |
| Futures | 15% |
| Sentiment | 10% |

When futures or sentiment data is unavailable, weights redistribute across available categories to maintain a 1.0 sum. The final composite score is the weighted sum of category scores, clamped to [-100, +100].

### Signal Tiers

| Tier | Score Range |
|------|-------------|
| `strong_buy` | > 60 |
| `buy` | 30 to 60 |
| `neutral` | -30 to 30 |
| `sell` | -60 to -30 |
| `strong_sell` | < -60 |

### Confidence

Base confidence starts at 100% and degrades for missing data sources:

- Missing futures data: -15%
- Missing sentiment data: -10%

Final confidence clamped to [0, 100].

## Backtesting Engine

The backtesting engine runs bar-by-bar simulation against historical candle data, producing trade-level and portfolio-level performance metrics.

### Data Requirements

- Minimum 200 candles (required for SMA200)
- Recommended 500+ candles for full indicator suite
- Warmup period computed based on longest indicator period

### Simulation Loop

1. Compute all indicator arrays upfront (full array computation, no look-ahead bias)
2. Iterate from warmup bar to end
3. For each bar:
   - Check stop-loss/take-profit against candle high/low (intra-bar evaluation)
   - Interpret indicators at current bar index via `interpretIndicatorsAtBar()`
   - Compute signal score
   - Evaluate entry/exit conditions
   - Update equity curve
   - Report progress to UI via Web Worker messages

### Entry and Exit Logic

**Long Entry**: Signal score >= entry threshold (default 30), no open position.

**Short Entry**: Signal score <= short entry threshold (default -30), shorts enabled, no open position.

**Exit Conditions** (evaluated in order):

1. Stop-loss: candle low/high breaches SL price
2. Take-profit: candle high/low breaches TP price
3. Signal reversal: score crosses exit threshold
4. End of data: force close at last bar

### Position Sizing Methods

**Fixed Percent** (default): Simple percentage of equity per trade.

| |
|---|
| `quantity = (equity * positionSizePercent) / entryPrice` |

**Fixed Fractional**: Risk a fixed fraction of equity per trade, sized by distance to stop-loss.

| |
|---|
| `dollarRisk = equity * riskPerTrade`<br>`quantity = dollarRisk / abs(entryPrice - stopLossPrice)` |

**Kelly Criterion**: Optimal sizing based on historical win rate and payoff ratio.

| |
|---|
| `b = avgWin / abs(avgLoss)`<br>`kellyFraction = (winRate * b - (1 - winRate)) / b`<br>`scaledKelly = kellyFraction * fractionKelly`  (default 0.5 for half-Kelly)<br>`quantity = (equity * clamp(scaledKelly, 0, 1)) / entryPrice` |

Requires at least 5 completed trades for history. Falls back to fixed percent otherwise.

### Performance Metrics

#### Trade Statistics

- Total trades, winning trades, losing trades
- Win rate, profit factor (gross profit / gross loss)
- Average win/loss (dollar and percent)
- Max consecutive wins/losses
- Total fees

#### PnL Calculations

| |
|---|
| `PnL (long) = (exitPrice - entryPrice) * quantity - fees`<br>`PnL (short) = (entryPrice - exitPrice) * quantity - fees`<br>`fees = entryNotional * feePercent + exitNotional * feePercent` |

#### Risk Metrics

| Metric | Formula |
|--------|---------|
| Max Drawdown | Largest peak-to-trough decline in equity curve (dollar and percent) |
| Sharpe Ratio | `(meanDailyReturn / stdDev) * sqrt(252)` |
| Sortino Ratio | `(meanDailyReturn / downsideDeviation) * sqrt(252)` |
| Calmar Ratio | `totalPnlPercent / maxDrawdownPercent` |

Sortino uses only negative returns for downside deviation:

| |
|---|
| `downsideReturns = returns.filter(r => r < 0)`<br>`downsideVariance = sum(r^2) / count`<br>`downsideDeviation = sqrt(downsideVariance) * sqrt(252)` |

### Web Worker

The backtest runs in a dedicated Web Worker (`src/workers/backtest.worker.ts`) to avoid blocking the UI. Communication protocol:

- **Request**: `{ type: 'run', candles, config, symbol, interval }`
- **Progress**: `{ type: 'progress', progress, barsProcessed, totalBars }`
- **Complete**: `{ type: 'complete', result: BacktestResult }`
- **Error**: `{ type: 'error', message }`

The `useBacktest()` hook manages worker lifecycle, providing `run()`, `cancel()`, status, progress, and result state.

## Trading Journal

The journal system records trading decisions alongside signal data, enabling retrospective analysis of decision quality.

### Entry Schema

| Field | Type | Description |
|-------|------|-------------|
| userId | string | Owner |
| symbol | string | Trading pair (e.g., BTCUSDT) |
| interval | string | Timeframe (15m, 1h, 4h, 1d) |
| signalScore | number | Signal score at time of entry (-100 to 100) |
| signalTier | string | Tier at time of entry |
| action | string | Action taken: buy, sell, hold, skip |
| entryPrice | number or null | Entry price if action = buy |
| exitPrice | number or null | Exit price when closing |
| outcomePnlPercent | number or null | Realized PnL% when closed |
| notes | string | User notes (max 1000 chars) |
| reviewedAt | Date or null | Timestamp when reviewed |

Maximum 500 entries per user.

### Workflow

1. **Create**: Capture current signal score/tier, record action taken, optional entry price and notes.
2. **Update**: Add exit price when closing position. System calculates `outcomePnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100`. Add retrospective notes. Mark as reviewed.
3. **Review**: Compare actual outcome vs signal prediction to identify decision patterns.

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/journal` | List entries (sorted by createdAt desc) |
| POST | `/api/journal` | Create entry |
| GET | `/api/journal/[id]` | Get single entry |
| PATCH | `/api/journal/[id]` | Update entry |
| DELETE | `/api/journal/[id]` | Delete entry |

## Portfolio Management

### Portfolio Structure

Each user can have multiple named portfolios. Each portfolio contains holdings, and each holding tracks transactions.

**Portfolio**: `userId`, `name` (unique per user), `holdings[]`

**Holding**: `symbol`, `baseAsset`, `quoteAsset`, `quantity`, `avgBuyPrice`, `transactions[]`

**Transaction**: `type` (buy/sell), `quantity`, `price`, `date`, `notes`, `fee`

### Transaction Processing

**Buy**: Adds to holding quantity and recalculates weighted average cost basis:

| |
|---|
| `totalCost = (existingQty * existingAvg) + (newQty * newPrice + fee)`<br>`totalQty = existingQty + newQty`<br>`avgBuyPrice = totalCost / totalQty` |

**Sell**: Subtracts from holding quantity. Does not change `avgBuyPrice` (cost basis preserved for remaining shares).

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/portfolio` | List/create portfolios |
| GET/PATCH/DELETE | `/api/portfolio/[id]` | Portfolio CRUD |
| GET/POST | `/api/portfolio/[id]/holdings` | List/add holdings |
| PATCH/DELETE | `/api/portfolio/[id]/holdings/[symbol]` | Holding CRUD |
| POST | `/api/portfolio/[id]/holdings/[symbol]/transactions` | Add transaction |

## Analytics System

### Daily Portfolio Snapshots

A cron job (`GET /api/cron/snapshot-portfolios`, authenticated via `CRON_SECRET` bearer token) runs daily:

1. Truncate current date to midnight UTC
2. Check Redis deduplication key (`snapshot:YYYY-MM-DD`, 24h TTL)
3. Fetch all portfolios with holdings
4. Fetch current prices for all held symbols
5. For each portfolio, compute and upsert snapshot:

| |
|---|
| `totalValue = sum(quantity * currentPrice)`<br>`totalCost = sum(quantity * avgBuyPrice)`<br>`unrealizedPnl = totalValue - totalCost`<br>`unrealizedPnlPercent = (unrealizedPnl / totalCost) * 100` |

Snapshots are uniquely indexed on `{ portfolioId, date }`.

### Risk Metrics

Computed from snapshot history via `GET /api/analytics/metrics?portfolioId={id}`.

**Data Requirements**:
- Minimum 2 snapshots for basic metrics
- Minimum 7 for max drawdown
- Minimum 30 for Sharpe/Sortino

| Metric | Formula |
|--------|---------|
| Annualized Volatility | `dailyStdDev * sqrt(365)` |
| Max Drawdown | `(peak - trough) / peak` |
| Sharpe Ratio | `(annualizedReturn - 0.05) / annualizedVolatility` (5% risk-free rate) |
| Sortino Ratio | `(annualizedReturn - 0.05) / downsideVolatility` |
| Annualized Return | `(1 + totalReturn)^(365/days) - 1` |
| Total Return | `(lastValue - firstValue) / firstValue` |
| Best/Worst Day | Single-day returns with dates |

### Cost Basis and Tax Reporting

`GET /api/analytics/cost-basis?portfolioId={id}&method={fifo|lifo|hifo}`

**Methods**:
- **FIFO** (First-In-First-Out): Oldest lots sold first (default)
- **LIFO** (Last-In-First-Out): Newest lots sold first
- **HIFO** (Highest-In-First-Out): Highest cost lots sold first (minimizes taxable gains)

**Tax Lot Tracking**: Each buy transaction creates a lot with `date`, `quantity`, `pricePerUnit`, `fee`, `remainingQuantity`. Sells match against lots per selected method.

**Realized Gain Calculation**:

| |
|---|
| `proceeds = sellQty * sellPrice - sellFeeShare`<br>`costBasis = sellQty * lot.pricePerUnit`<br>`gain = proceeds - costBasis`<br>`holdingPeriod = (sellDate - buyDate) > 365 days ? long-term : short-term` |

### CSV Export

`GET /api/analytics/export?portfolioId={id}&year={year}&method={method}&format={format}`

Supported formats:
- **generic**: Standard CSV with all fields
- **koinly**: Koinly-compatible import format
- **cointracker**: CoinTracker-compatible import format

Optional `year` filter restricts to transactions within a single tax year.

## Alerts System

### Alert Types

| Type | Condition | Required Fields |
|------|-----------|-----------------|
| `price_above` | Current price >= target | `symbol`, `targetPrice` |
| `price_below` | Current price <= target | `symbol`, `targetPrice` |
| `price_change_pct` | abs(% change from reference) >= threshold | `symbol`, `referencePrice`, `percentChange` |
| `portfolio_value_above` | Portfolio total value >= target | `portfolioId`, `targetPrice` |
| `portfolio_value_below` | Portfolio total value <= target | `portfolioId`, `targetPrice` |
| `holding_change_pct` | Holding PnL% >= threshold | `portfolioId`, `symbol`, `percentChange` |

### Alert Properties

| Field | Description |
|-------|-------------|
| status | `active`, `triggered`, `paused` |
| recurring | If true, auto-resets after cooldown instead of staying triggered |
| cooldownMinutes | Minimum interval between recurring triggers (default 60) |
| message | Optional user-defined notification text |

### Cooldown Mechanism

**Non-recurring alerts**: Trigger once, status set to `triggered`, never re-evaluated.

**Recurring alerts**: Remain `active` after trigger. `lastTriggeredAt` updated on each trigger. Skipped during evaluation if within cooldown period. Re-trigger after cooldown expires.

| |
|---|
| `isWithinCooldown = (now - lastTriggeredAt) < cooldownMinutes * 60 * 1000` |

### Cron Evaluation

`GET /api/cron/check-alerts` (authenticated via `CRON_SECRET` bearer token, recommended every 1-5 minutes):

1. Fetch all alerts where `status = 'active'`
2. Group by type (price / portfolio / holding)
3. Collect all needed symbols from alerts and portfolio holdings
4. Fetch current prices (cached 30s)
5. Evaluate each alert against current data
6. For triggered alerts: update status and timestamps
7. Return `{ evaluated: count, triggered: count }`

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/alerts` | List/create alerts |
| GET/PATCH/DELETE | `/api/alerts/[id]` | Alert CRUD |

## Architecture

### Authentication

NextAuth.js v5 with JWT session strategy.

**Providers**: Credentials (email/password with bcrypt), Google OAuth, GitHub OAuth.

**Adapter**: `@auth/mongodb-adapter` for account/session persistence.

**Flow**: User submits credentials -> `authorizeCredentials()` validates via User model -> bcrypt.compare() checks hash -> JWT generated with user.id -> custom callbacks inject user.id into session.

**Protected Routes**: Server actions call `auth()` to verify session. API routes return 401 if no session.

### Database (MongoDB + Mongoose)

Global cached connection pattern (`globalThis.mongoose`) with connection pooling.

| Model | Collection | Key Indexes | Notes |
|-------|-----------|-------------|-------|
| User | users | `email` (unique) | |
| Watchlist | watchlists | `userId`, `{ userId, symbol }` (unique) | |
| Portfolio | portfolios | `userId`, `{ userId, name }` (unique) | |
| Alert | alerts | `{ userId, status }`, `status` | |
| PortfolioSnapshot | portfoliosnapshots | `userId`, `{ portfolioId, date }` (unique) | |
| Strategy | strategies | `userId` | Max 5 per user |
| Signal | signals | `{ userId, symbol, createdAt }`, `createdAt` TTL 90d | Auto-deletes after 90 days |
| JournalEntry | journalentries | `{ userId, createdAt }`, `{ userId, symbol }` | Max 500 per user |
| BacktestResult | backtestresults | `{ userId, createdAt }`, `{ userId, strategyId }` | Max 50 per user |

### Caching (Upstash Redis)

HTTP-based Redis client, serverless-compatible. Graceful degradation: if Redis is unavailable, caching is skipped and the fetcher runs directly.

**cachedFetch pattern**:

| |
|---|
| `async function cachedFetch<T>(key, fetcher, ttlSeconds)`<br>1. Try get from Redis<br>2. If miss or unavailable: call fetcher()<br>3. Try set to Redis with TTL<br>4. Return data regardless of cache status |

**Cache Keys**:

| Key Pattern | TTL | Usage |
|------------|-----|-------|
| `klines:{symbol}:{interval}:{limit}` | 60s | Historical candle data |
| `cron:prices:{symbols}` | 30s | Batch price lookups |
| `futures:funding:{symbol}:1` | 300s | Funding rate |
| `futures:ls:top:{symbol}:1h:1` | 300s | Long/short ratio |
| `snapshot:YYYY-MM-DD` | 24h | Snapshot deduplication |

### WebSocket (Binance Streams)

**useBinanceTicker(symbols)**: Multi-stream ticker subscription (`{symbol}@ticker`). Returns live ticker data mapped by symbol. Batches UI updates via `requestAnimationFrame`.

**useBinanceKline(symbol, interval)**: Single-stream kline subscription (`{symbol}@kline_{interval}`). Returns latest candle data and `isClosed` flag for completed candles.

Both hooks use a generic `useWebSocket` hook with auto-reconnect (exponential backoff, max 5 attempts) and cleanup on unmount.

Base URL configured via `NEXT_PUBLIC_BINANCE_WS_URL` environment variable.

### Client State (Zustand)

**uiStore**: Sidebar state, selected symbol (default BTCUSDT), selected interval (default 1h), chart type (candle_solid, candle_stroke, ohlc, area, etc.).

### Cron Jobs

Three cron endpoints, all authenticated via `CRON_SECRET` bearer token:

| Endpoint | Recommended Schedule | Purpose |
|----------|---------------------|---------|
| `GET /api/cron/check-alerts` | Every 1-5 minutes | Evaluate active alerts against current prices |
| `GET /api/cron/snapshot-portfolios` | Daily at 00:00 UTC | Capture daily portfolio value snapshots |
| `POST /api/cron/compute-signals` | Configurable | Compute signals for active strategies |

### Strategy System

Users define up to 5 strategies, each with:
- 1-5 symbols to monitor
- Timeframe intervals (15m, 1h, 4h, 1d)
- Custom signal weight profiles
- Active/inactive toggle for cron-based auto-computation

The signal cron job iterates active strategies, computes signals for each (symbol, interval) pair, and saves results to the Signal collection (90-day TTL).

### Binance API Integration

**REST**: Ticker stats, historical klines, batch prices, exchange info (USDT pairs only).

**Futures REST**: Funding rate, open interest, long/short ratio.

**Base URL**: Configurable via `BINANCE_API_URL` environment variable. Defaults to `https://api.binance.com/api/v3`. Allows proxy configuration for geo-restricted regions (Binance returns 403 from US IPs).

### API Route Summary

| Category | Routes |
|----------|--------|
| Auth | `/api/auth/register`, `/api/auth/[...nextauth]` |
| Market Data | `/api/symbols`, `/api/prices`, `/api/prices/history` |
| Portfolio | `/api/portfolio/**` |
| Analytics | `/api/analytics/history`, `/api/analytics/metrics`, `/api/analytics/cost-basis`, `/api/analytics/export` |
| Alerts | `/api/alerts/**` |
| Signals | `/api/signals`, `/api/signals/compute` |
| Strategies | `/api/strategies/**` |
| Journal | `/api/journal/**` |
| Backtests | `/api/backtests/**` |
| Futures | `/api/futures/funding`, `/api/futures/open-interest`, `/api/futures/long-short` |
| Watchlist | `/api/watchlist` |
| Cron | `/api/cron/check-alerts`, `/api/cron/snapshot-portfolios`, `/api/cron/compute-signals` |
