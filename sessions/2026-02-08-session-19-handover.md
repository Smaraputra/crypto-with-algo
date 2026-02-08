# Session 19 Handover -- Phase 5: Analytics System (Steps 41-49)

## Session Summary

Implemented the complete Phase 5 analytics system across 9 steps (41-49). This transforms the tracker from a real-time monitoring tool into a portfolio analysis platform with daily value snapshots, FIFO cost basis accounting, risk metrics, interactive charts, and tax-ready CSV export.

## Commits (This Session)

| Hash | Message |
|------|---------|
| 5724185 | feat(analytics): add PortfolioSnapshot model, analytics types, and shared fetchJson |
| 24240d3 | feat(analytics): add daily portfolio snapshot cron endpoint |
| b28edc3 | feat(analytics): add FIFO cost basis engine with realized gain tracking |
| c9b6b89 | feat(analytics): add risk metrics utility and analytics API routes |
| 6df4618 | feat(hooks): add analytics TanStack Query hooks for history, cost-basis, and metrics |
| 6d2991c | feat(analytics): add portfolio value chart with lightweight-charts |
| 8eb9da6 | feat(analytics): add analytics dashboard with cost basis table and risk metrics |
| b8c81b4 | feat(analytics): add tax CSV export with FIFO gain/loss reporting |
| (pending) | feat(analytics): add E2E tests and phase 5 polish |

## What Was Built

### Step 41: PortfolioSnapshot Model, Types, Shared Utilities
- `src/types/analytics.ts` -- all analytics type definitions
- `src/lib/models/portfolio-snapshot.ts` -- Mongoose model with compound unique index `{ portfolioId, date }`, pre-save date truncation to midnight UTC
- `src/lib/fetch-json.ts` -- extracted shared utility from duplicated code in usePortfolio and useAlerts
- `src/__fixtures__/analytics.ts` -- comprehensive test fixtures
- 22 new tests

### Step 42: Snapshot Cron Endpoint
- `src/app/api/cron/snapshot-portfolios/route.ts` -- CRON_SECRET auth, Redis dedup, batch price fetch, upsert snapshots
- 11 tests

### Step 43: FIFO Cost Basis Engine
- `src/lib/cost-basis.ts` -- pure utility with `computeFIFO()` and `computeHoldingCostBasis()`
- Tax lot tracking, realized gain calculation, short/long-term holding period (365-day boundary), fee handling
- 19 tests (15+ scenarios including edge cases)

### Step 44: Risk Metrics + API Routes
- `src/lib/risk-metrics.ts` -- annualized volatility, max drawdown, Sharpe ratio, Sortino ratio, best/worst day
- 3 API routes: `/api/analytics/history`, `/api/analytics/cost-basis`, `/api/analytics/metrics`
- All routes have session auth, ownership checks, Zod validation
- 31 tests total

### Step 45: Analytics TanStack Query Hooks
- `src/hooks/useAnalytics.ts` -- `usePortfolioHistory`, `useCostBasis`, `useRiskMetrics`, `useExportCsv`
- 5min staleTime, shared fetchJson
- 14 tests (later expanded to 17 with export hook)

### Step 46: Portfolio Value Chart
- `src/components/analytics/PortfolioValueChart.tsx` -- `lightweight-charts` library, area chart with green/red fill, range selector, responsive resize
- lightweight-charts v5 API: `chart.addSeries(AreaSeries, options)` (NOT `addAreaSeries`)
- 6 tests

### Step 47: Analytics Dashboard Page
- `src/app/(dashboard)/analytics/page.tsx` -- Tabs: Overview, Cost Basis, Risk Metrics
- `AnalyticsSummaryCards` -- Total Value, Unrealized P&L, Realized P&L, Period Return
- `CostBasisTable` -- expandable FIFO table with tax lots, total footer, Export CSV button
- `RiskMetricsCards` -- 6 metric cards with insufficient data state
- Sidebar updated with Analytics nav link (BarChart3 icon)
- 13 tests

### Step 48: Tax CSV Export
- `src/lib/csv-export.ts` -- generates generic CSV with FIFO gain/loss, year filtering
- `src/app/api/analytics/export/route.ts` -- text/csv response with Content-Disposition
- `useExportCsv` mutation hook triggers browser download
- Download button on CostBasisTable
- 26 tests (14 utility + 9 API + 3 hook)

### Step 49: E2E Tests and Polish
- `e2e/analytics.spec.ts` -- 8 E2E tests
- Updated `e2e/dashboard-layout.spec.ts` for Analytics sidebar link
- Changelog updated with Phase 5 entries

## Test Counts

| Category | Count |
|----------|-------|
| Unit tests | 776 (84 files) |
| E2E tests | 41 (6 spec files + 1 setup) |
| New unit tests (Phase 5) | 143 |
| New E2E tests (Phase 5) | 8 |

## Key Technical Decisions

- **lightweight-charts** over KlineCharts for portfolio value chart -- KlineCharts OHLCV format is semantically wrong for single-value time series
- **FIFO only** for cost basis -- most common for crypto; LIFO/HIFO can be added as a parameter later
- **Daily snapshots** via cron -- sufficient for risk metrics without burning quotas
- **Generic CSV format** -- vendor-neutral for Koinly/CoinTracker/accountant compatibility
- **Risk metric minimums** -- 7 days for drawdown, 30 days for Sharpe/Sortino

## Issues and Workarounds

- **lightweight-charts v5 API change**: `addAreaSeries()` removed, use `addSeries(AreaSeries, options)`
- **E2E chart test**: `portfolio-value-chart` Card wrapper and `chart-empty` both visible simultaneously caused strict mode violation in `.or()` chain -- fixed by checking outer Card only
- **useExportCsv test**: mocking `document.createElement` breaks `renderHook` -- fixed by mocking after initial render
- **RiskMetricsCards**: unused imports `CardHeader`/`CardTitle` flagged by lint -- removed

## Current State

- Phase 1-5 all COMPLETE (49 steps)
- Build passes, TypeScript clean, lint clean (warnings only)
- 776 unit tests passing, 41 E2E tests passing
- All analytics features functional: snapshots, FIFO, risk metrics, charts, CSV export

## Potential Next Steps

- Phase 6: Rebalancing (target allocations, drift analysis, trade suggestions)
- Performance optimization (lazy loading analytics components)
- Additional cost basis methods (LIFO, HIFO)
- Vendor-specific CSV adapters (Koinly, CoinTracker)
