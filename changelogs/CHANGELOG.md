# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (research toolkit)
- `scripts/research/export-dataset.ts`: exports Candle, HistoricalSnapshot, and derived HTF-confluence data to gzip newline-delimited JSON under `data/research/` (gitignored), one file per symbol, interval, and kind, plus a `manifest.json` listing every file's row count, timestamp range, and sha256, and a dataset-wide hash (sha256 over the sorted per-file hashes) so two exports of the same data always hash identically. Candles are read through a Mongoose cursor sorted ascending rather than `getCandles`, which caps at 50,000 rows. HTF context is computed once per symbol and interval with a 250-bar warmup before the requested start and aligned with `alignHtfToLtf` so each row's context comes from the newest higher-timeframe bar closed at or before that bar, keeping the HTF file's row count equal to the candle file's even when every context is null (no confirmation interval for 1d, or indicator warmup not yet satisfied)
- `scripts/research/load-dataset.ts`: loads exported candles, snapshots, and HTF rows and enforces a lockbox on data from 2026-07-01 onward, dropped by default and reported via `droppedRows`, kept only when a caller explicitly passes `allowLockbox`. `verifyManifest` recomputes every file's sha256 and the dataset hash so a single tampered byte is reported by path. Research subagents read this dataset instead of Mongo, so every agent works from one identical, hashed, held-out dataset
- `scripts/research/dataset-format.ts`: the shared, Mongo-free row and manifest shapes (`CandleRow`, `SnapshotRow`, `HtfRow`, `DatasetManifest`) plus the gzip newline-delimited JSON read/write and sha256 helpers both scripts above build on
- `scripts/{ops,research}/**/*.{test,spec}.ts` added to Vitest's test include, alongside the existing `src/**` pattern, so script-level unit and mongodb-memory-server integration tests run under `npm run test`
- `scripts/research/ic-stats.ts`: pure information-coefficient statistics for the factor study -- rank with average-rank ties, Spearman correlation, forward returns, Newey-West (HAC) mean/se/t-stat, `icWithHac` (every overlapping bar, HAC-corrected t at lag h-1) and `icNonOverlapping` (every h-th bar, naive t), sign hit rate, quantile spread, a stationary block bootstrap and percentile confidence interval, and per-quarter rolling IC. `standardizedRankProducts` (the per-pair terms `icWithHac` already averages to get `ic`) and `bootstrapCiOfMean` (percentile bootstrap CI for a series' mean, same block/seed semantics as `bootstrapCi`) together give a fixed-rank block bootstrap of a Spearman IC: ranks computed once, not re-ranked inside every resample, so each iteration is O(n) instead of the O(m log m) sort `bootstrapCi` pays every time -- `factor-ic.ts`'s CLI uses this pair, not `bootstrapCi`, which stays exported and covered by its own tests for any other caller
- `scripts/research/factors.ts`: `computeFactorMatrix` builds a causal, per-bar factor matrix from exported dataset rows using the same code paths live scoring uses -- `prepareBacktest`'s indicator suites and SuperTrend, `computeSignalScore` with the interval's style and `DEFAULT_TEMPLATE_WEIGHTS`, and the HTF context C1 already exported per bar. One factor per fired `IndicatorSignal` (`sig.*`), one per scorer category (`cat.*`), the composite score, and twelve raw factors (RSI, EMA spread, ATR%, funding rate, long/short ratio, taker buy ratio, Fear & Greed, HTF trend, 1/5/20-bar returns, 20-bar realized vol). Every value is NaN before indicator warmup or when its own input is missing at that bar, never defaulted to zero
- `scripts/research/report-schema.ts`: Zod schemas for `FactorIcReport` and `SubagentReport`, validated with `validateFactorIcReport`/`validateSubagentReport` (`{ ok: true, data }` or `{ ok: false, issues }`, built from `ZodError.issues`). `SURVIVOR_RULE` (`minAbsIc` 0.02, `minT` 2.5, `minHorizons` 2, `minQuarterAgreement` 0.6, `minSymbolAgreement` 0.7) and `evaluateSurvivors` apply one fixed rule to every factor: a horizon passes on the pooled `|ic|`/`|icT|`, then quarter and symbol agreement (both measured only at the horizons that passed, against the sign of the strongest-`|icT|` passing horizon) test whether that effect holds over time and across symbols rather than surviving on one quarter or one symbol. `checkFindings` grounds a subagent's headline claims against the study's own tables (any numeric field of the matching `HorizonStat`s or rolling-quarterly entries other than `horizon`/`n`, an index and a sample size rather than a statistic, pooled plus rolling when no symbol is named, the named symbol's table otherwise), and `spotCheckCell` compares a freshly recomputed (ic, n) against the report's value for the orchestrator's re-run spot checks. `FactorIcReport.bootstrap` also carries `gateAbsT`/`maxPairs`, and `FactorIcReport` gains `skippedFactors` (name, category, reason), both described below
- `scripts/research/factor-ic.ts`: the factor IC study CLI four research subagents run, one per interval. Verifies the dataset manifest, loads every requested symbol through C1's lockbox-aware loaders (snapshots forced null on 5m/15m, which never have a snapshot file), builds each symbol's causal factor matrix, and for every requested factor measures `icWithHac`/`icNonOverlapping`/`signHitRate`/`quantileSpread` per symbol and pooled (concatenated in symbol order), plus pooled rolling-quarterly IC. A factor/horizon with fewer than 3 usable pairs anywhere (e.g. a funding-rate-derived factor on 5m/15m, which is NaN for every bar) is omitted rather than written as NaN, since `FactorIcReport`'s numeric fields are plain, schema-validated numbers; a factor with no usable horizon at all is recorded in `skippedFactors` (with a reason) instead of silently disappearing from the report. Pooled `bootstrapCi95` is only computed for a (factor, horizon) cell whose pooled HAC `|icT|` is at least `gateAbsT` (2); other cells carry `bootstrapCi95: null`. A pooled series larger than `maxPairs` (default 100,000, `--bootstrap-max-pairs`) is deterministically reduced before bootstrapping: split into 20 equal strata, one seeded-random contiguous block kept per stratum and concatenated in order, so a multi-symbol pooled series stays represented across every symbol while each kept block's internal autocorrelation structure is unbroken. The bootstrap itself is a fixed-rank block bootstrap (`ic-stats.ts`'s `standardizedRankProducts`/`bootstrapCiOfMean`, not `bootstrapCi`): ranks computed once per (sub)sample rather than re-ranked per resample, an approximation standard at this sample size, without which the unconditional "always on" pooled bootstrap measured at roughly 15 minutes per cell at production scale, and even the gated, subsampled, re-ranking version still measured about 21 seconds per gated cell; the fixed-rank version measures about 0.3 seconds per gated cell at the same 100,000-pair, 200-iteration bound. Default `--bootstrap-n` is 200 (was 1000). Per-symbol `bootstrapCi95` (`--bootstrap-per-symbol`, off by default) uses the same fixed-rank method, ungated. Validates against `FactorIcReportSchema` before writing, prints the top 15 pooled `|icT|` (factor, horizon) rows across all horizons, the survivor count, and the skipped-factor count to stdout, progress to stderr. `--cell factor:horizon[:symbol]` recomputes and prints one cell's (ic, n) with no file written, for the orchestrator's spot checks

### Fixed (research toolkit whole-branch review)
- `export-dataset.ts` computed every interval's HTF context with `computeHtfSeries`'s default config, which equals `day_trading`'s EMA/SMA periods -- silently wrong for every other style (5m/scalping's 5/13 EMA and 20/50 SMA, 4h/swing's 21/55 EMA, in particular), corrupting `sig.HTF*`, `cat.htf`, `raw.htfTrend`, and `composite` in the exported dataset itself, not just at read time. `buildHtfRows` now takes the LTF interval's own style config (`getStyleConfig(styleForInterval(interval)).config`, the same style resolution `factors.ts` uses, now exported from there), matching live scoring's `computeHtfSeries(closed, profile.config)`. HTF warmup candles are now fetched by bar count (`fetchCandlesBefore`, at least the style's longest lookback -- `max(ema.slow, sma.long)` -- plus a 50-bar margin) rather than by subtracting a fixed duration from the export start, so gaps in the underlying data cannot starve the warmup below what the indicators need
- `factors.ts`'s `computeFactorMatrix` fires an Ichimoku signal for scalping, unlike live scoring (`computeIndicatorsForStyle` nulls Ichimoku for scalping before interpretation; `prepareBacktest`/`interpretIndicatorsAtBar`, the shared backtest indicator path this file also uses, has no such style awareness -- a pre-existing divergence any backtest/harness branch built on `optimized-engine.ts` inherits too, noted in this file's header as a caveat). `computeFactorMatrix` now strips Ichimoku's raw reading and derived trend signal from the suite it hands to the scorer when style is scalping, so `sig.Ichimoku` is absent at 5m as it is live. Also: bars before `warmupBars` are no longer scored at all (nothing downstream ever read that work); `htf` is now required to be index-aligned with `candles` (same row count, same timestamps per row), checked and thrown on rather than trusted, since a silent misalignment would attribute the wrong HTF context to a bar with no error
- `factor-ic.ts`'s forward-return cache stored `(number | null)[]` per (symbol, horizon), which forces V8 into boxed/tagged array elements once `null` appears (measured 144.2 MB at 10 symbols x 6 horizons x 105,000 bars); it now caches `Float64Array` (NaN as the missing sentinel, measured ~48.1 MB and entirely off the V8 heap, in ArrayBuffer/external memory). `--horizons` rejects non-positive or non-integer values (a non-positive horizon previously reached `nonOverlappingIndices`, now guarded there too, and looped forever); an unrecognized `--flag` is now rejected instead of silently absorbing its value as a no-op. The CLI's loader path (`loadSymbolData`) now checks candle/HTF alignment independently of `computeFactorMatrix`'s own check (belt and suspenders across the two layers)
- Nothing pinned which dataset a `FactorIcReport` or `SubagentReport` was built from. `factor-ic.ts` gained `--expect-manifest-hash` (abort when the loaded dataset's manifest hash differs, checked in both the full-report and `--cell` paths) and `report-schema.ts` gained `checkReportConsistency(sub, factorReport)` (fails when `datasetManifestHash` or `lockboxApplied` differ between a subagent's report and the factor report it cites). `--cell` also gained `--report <path>`: reads `symbols`, `dateRange` (as start/end), and `lockboxApplied` (as `!allowLockbox`) from that `FactorIcReport` and uses them unconditionally, so the orchestrator's spot check reproduces exactly the window a subagent's report was built from rather than whatever the CLI invocation's own flags said; the current dataset's manifest hash is also checked against the report's own in this mode
- `checkFindings` (`report-schema.ts`) no longer grounds a finding's value against a `HorizonStat`/rolling entry's `horizon` or `n` fields -- an index and a sample size, not a statistic a finding should be able to "cite" by coincidence
- `factors.test.ts` now hand-computes `raw.emaSpreadPct` and `raw.realizedVol20` (alongside the existing `raw.ret1` hand computation) from an independently prepared suite/raw closes. `dataset-format.ts`'s `readJsonlGz` gained a doc warning that it bypasses the lockbox (use `load-dataset.ts`'s loaders instead), and a test confirms two writes of the same rows produce byte-identical gzip files (Node's default gzip mtime is already 0, so this was already true; the test locks it in)

### Added (evaluation harness)
- Pure statistics module (`src/lib/stats/`) for the strategy validation gate: a seeded mulberry32 generator, a stationary block bootstrap with a percentile confidence interval and max-drawdown-percent helper, normal distribution helpers (CDF, quantile, sample skewness and kurtosis), the deflated Sharpe ratio (Bailey and Lopez de Prado), and a parameter plateau score. No engine or Mongo dependency; all Sharpe values are per period, not annualized

### Added (signal outcomes)
- `SignalOutcome` model and resolver record what each stored `GlobalSignal` predicted against what price actually did. A pending outcome is created per signal with a per-style horizon (scalping 12 bars, day trading 24, swing trading 30, position trading 20), and `resolveDueOutcomes` fills in the forward return, MFE, and MAE from stored candles once the horizon bar has closed, marking outcomes `unresolvable` when candle data is missing (a group whose candle fetch fails is logged and left pending rather than blocking the whole batch, reported as `failedGroups`). Runs from `/api/cron/resolve-outcomes` every 15 minutes. `getLiveTierExpectancy` aggregates resolved outcomes into per-tier expectancy, win rate, and MFE/MAE via a database aggregation, with sell tiers flipped to the long-equivalent direction and a configurable round-trip cost, so live accuracy can be measured with the same math backtests use. `docker/crontab.template` is bind-mounted read-only, so `docker compose up -d --build` alone does not pick up the new cron line: after deploying, run `docker compose -f docker-compose.server.yml up -d --force-recreate cron`

### Fixed (candle finalization)
- `syncCandles` fetched from `range.newest + 1` and `backfillCandles`'s after-gap fetch from `existing.newest + 1`, but Binance filters klines on open time inclusively, so the bar that was newest and still open at the previous run was never fetched again. Every bar written by the incremental cron was therefore stored with partial open, high, low, close, volume, and takerBuyVolume forever, repairable only by an admin refill. A new `dropOpenBars` helper in `candle-ingestion.ts` drops any candle whose close time (`timestamp + interval duration`) is after now, and every write path (`syncCandles`, and `backfillCandles`'s before-gap, after-gap, and refill fetches) passes its batch through it before `bulkUpsertCandles`. `range.newest` is now always a closed bar, so fetching from `newest + 1` no longer misses anything
- The live signal engine scored the latest stored bar of the primary interval even when it was still open; only the HTF confirmation path filtered to closed bars. `computeSignalBatch` in `compute-engine.ts` now filters the primary interval's fetched candles to closed bars using the shared `dropOpenBars` helper (same as the HTF path), before computing indicators, score, `candleTimestamp`, and session, and skips the task with a log line if none remain. Every other signal writer applies the same filter: the legacy per-user cron path in `compute-signals/route.ts` and the on-demand per-user path in `signals/compute/route.ts` both skip (log line; the latter returns `500` with `error: 'No closed candle available'`, matching the global branch's existing "no result" status for the same "nothing scoreable right now" condition), since neither goes through the compute engine. In practice this means a live signal is now published only after its bar closes, and with the current crontab as much as one compute cycle later still (a `1d` position-trading signal can land up to about an hour after the daily close, since that style's compute cron runs hourly). `GlobalSignal.configVersion` is now 4 (was 3): rows written before it may have been scored on a still-forming bar's partial values
- The `cachedFetch` producer behind `fetchCandlesForTask` (compute-engine) and both legacy routes' candle fetch caches its result for 60 seconds; when Mongo holds fewer than the recommended candle count, the Binance REST fallback's response (always ending in the still-forming bar) was cached as-is. A bar open when the cache was written stayed partial for the life of that cache entry, but a later read within the same 60 seconds could re-evaluate the closed-bar check against a `Date.now()` that had since moved past the bar's close, letting the stale partial bar through. `dropOpenBars` now runs inside the producer, before the value is cached, using a single `now` captured once per batch (compute-engine) or per request (both routes) and threaded into every `dropOpenBars` call including the HTF one, so one batch/request scores every symbol on the same bar boundary; the existing post-fetch filter stays as a safety net for candles read straight from Mongo
- `POST /api/signals/compute` accepted any string as `interval`; `dropOpenBars` throws on one it doesn't recognize, which would have surfaced as a `500` leaking the raw error message. `interval` is now `z.enum(VALID_INTERVALS)`, rejected with the existing `400` shape
- Production needs one refill pass over the recent windows (`scripts/ops/backfill-history.ts --refill` on the data-history branch) because bars synced before this fix hold partial values: 1m and 5m within their TTLs, 15m, 1h, 4h, and 1d back to the last refill on 2026-09-16

### Changed (candle finalization)
- The per-style `compute-signals` crons in `docker/crontab.template` now run one minute after the matching `sync-candles` cron (day trading `1-59/5`, swing trading `1-59/15`, position trading minute 1 of the hour) instead of on the same tick. Compute and sync firing at the same minute race: if sync has not yet written the newly-closed bar when compute reads Mongo, compute misses it and does not pick it up until the next cycle, up to a full cycle late. Scalping is unchanged, since its 1m/5m intervals already sync every minute

### Changed (data history)
- `HistoricalSnapshot` no longer carries a TTL index on `createdAt`. It expired snapshots one year after insert, which would have silently deleted the 60-96 months of funding and Fear and Greed history `backfill-history.ts` writes, and any row captured live for over a year. `scripts/ops/backfill-history.ts --drop-snapshot-ttl` drops the TTL index a production collection created before this change still carries, since Mongoose never drops an existing index on its own. Run it only after the app is redeployed from this branch: `mongoose.connect` leaves `autoIndex` on, so an app container still running the old schema recreates the dropped index the next time it writes a snapshot
- 5m candles are now durable instead of TTL-backed: `HF_INTERVALS` on `Candle` carries only `1m`, so 5m rows are kept indefinitely rather than expiring after 14 days. Scalping research needs up to 12 months of 5m history. Rows written before this change still carry the `expiresAt` set under the old TTL; `scripts/ops/backfill-history.ts --unset-5m-ttl` clears it. Same redeploy-first caveat as `--drop-snapshot-ttl`: an old app container keeps writing `expiresAt` onto 5m candles until it is replaced
- Admin candle and snapshot backfill accept up to 120 months (was 48). 5m and 15m are capped at 12 months each on both routes, since a year of bars at that density is already a large document count
- Per-symbol/interval snapshot backfill (recent long/short and open interest fetch, `buildBackfillSnapshots`, chunked upsert) and the Fear & Greed carry-forward lookup moved from the admin snapshot backfill route into `src/lib/snapshot-backfill.ts` as `backfillSnapshotRange` and `loadFearGreedLookup`, so the new ops script runs the same logic the route does. Route behavior is unchanged

### Added (data history)
- `scripts/ops/backfill-history.ts`: committed ops script that backfills durable candle and snapshot history in production, run inside the Dockerfile's `seeder` stage so it needs no bind mount. `--dry-run` prints the planned jobs without connecting; `--unset-5m-ttl` clears `expiresAt` from 5m candles written before 5m became durable; a per-job failure is logged and the run continues, exiting 1 if anything failed. Each candle job's log line reports `requestedFrom`, `from`, `to`, and a `complete` flag, since `fetchKlinesRange`'s 120-second deadline can silently truncate a large window; re-running is safe and resumes from what is already stored
- `scripts/ops/backfill-history.ts --refill`: re-fetches every stored bar instead of only the gaps around them, for every candle job in the run. Intended for the first production candle pass after the candle finalization fix (a separate branch) deploys, since bars synced before it can hold partial values that only a refill repairs
- `scripts/ops/sync-prod-to-local.sh`: streams collections from the production Mongo to a local Mongo for research, one collection at a time with no intermediate file (`mongodump` piped straight into `mongorestore`, remote credentials expanding only inside the production container). Refuses to run unless `LOCAL_MONGO_URI` is localhost/127.0.0.1 or `FORCE_REMOTE_LOCAL=1` is set, since every collection is restored with `--drop`

### Changed (signal calibration)
- Signal tier cutoffs recalibrated from measured production score distributions: buy and sell above |24| (was 30), strong above |30| (was 60). Measured 2026-09-16 over every bar since 2026-03-04 for BTC, ETH, SOL, XRP, and BNB, with stored futures and sentiment data as live scoring uses it. Across all seven live style and interval pairs, |score| p90 fell between 22.2 and 26.1 and p98 between 29.4 and 31.3. Under the old cutoffs about 95% of live signals were neutral, swing trading was neutral on all 490 signals in a week, and no style reached a strong tier, because scores rarely pass |43|. `GlobalSignal.configVersion` is now 3 so tiers recorded under the old cutoffs remain distinguishable. Measurements are documented in `src/lib/signals/calibration.ts`
- Strategy thresholds for every style now enter at the buy tier (|24|) and exit at |6|, so an activated template trades on the tier users see. The previous levels inverted against the measured ranges: scalping required 50 while its scores never passed about 43, so all 350 scalping candidates in the first production optimization made zero trades, while position trading's 30 sat inside ordinary noise. Backtest presets are scaled by the same 0.8 ratio (Conservative 32, Balanced 24, Aggressive 16)
- Walk-forward stop-loss and take-profit are sized per window from the training bars' median true range (2x and 4x, preserving the previous 1:2 ratio), floored at five round-trip fees so fees cannot exceed a fifth of the risk per trade, and capped at 25%. The flat 3% and 6% applied to every style produced 338 stop-outs in 1,440 daily SOL bars while never engaging on 5m bars; a volatility-only stop without the fee floor gave 5m BTC a 0.25% stop against 0.2% round-trip fees and lost the whole account in a 90-day backtest

### Fixed (signal calibration)
- Monthly optimization could never save a template. With no active template, the orchestrator fell back to thresholds in an obsolete shape (`{ bullish, bearish, strong }`) that fails `SignalTemplate` validation, so day and swing trading, the first styles ever to pass walk-forward in production (2026-09-17), failed at the final step. Templates now store the style's default thresholds, which are the ones walk-forward optimized the weights against; an active template's thresholds could differ from those
- Binance returns an empty `markPrice` on funding events before mid-2023. It parsed to `NaN`, failed the schema cast, and the 48-month daily snapshot backfill wrote nothing for any symbol. Historical snapshots now store funding without `markPrice` when it is missing; nothing in scoring or backtesting reads it
- The admin snapshot backfill wrote at most 500 bars per request, whatever `months` said, because it took bar timestamps from the long/short ratio response, and it fetched a single page of funding (about 333 days). It now writes every bar across the window and pages funding history, with long/short and open interest attached where Binance still serves them. This matters for calibration: bars without Fear & Greed and funding score far wider than live bars (position trading |score| p90 of 54 against 25 with them), so optimization windows extending before snapshot coverage began traded on a distribution unlike live

### Fixed (production activation)
- Admin routes were unreachable in production: every one of the ten admin surfaces compared `session.user.email` against an unset `ADMIN_EMAIL`, and a comparison against `undefined` always fails, so a missing configuration returned an indistinguishable 401. The check is now a single `requireAdmin` helper in `src/lib/admin-auth.ts` that reports an unconfigured `ADMIN_EMAIL` as a 500 with a server-side log, keeping a configuration gap separate from a permissions denial. `ADMIN_EMAIL` documented in `.env.production.example`
- `position_trading` could never optimize: walk-forward needs `minTrainingBars + testWindowBars` (400) bars, and the flat six-month window supplied roughly 180 daily candles, so the job always threw `Insufficient data`. The window is now per style via `getMonthsForStyle` (scalping 3, day trading 12, swing 24, position 48 months), which also keeps the largest series under the 50,000-row candle read cap that six months of 5m candles would have exceeded
- Walk-forward step size is now derived from series length (`deriveStepSize`, targeting six windows) rather than fixed at 300 bars. The fixed step produced roughly 85 windows for a three-month 5m series and only one for a four-year daily series; each window costs `candidatesPerWindow` backtests over an expanding training set, so this bounds cost at both extremes. Measured after the change: seven windows and 357 backtests per style, about six seconds of engine time for all four styles
- Monthly optimization no longer auto-activates by default. `OPTIMIZATION_AUTO_ACTIVATE` (default false) gates the cron path and the admin trigger requires an explicit `autoActivate`, so the first run cannot promote unreviewed templates to live signals
- `backfillCandles` could not repair candles already inside the stored range, because it only fetched the gaps around stored data. Fields added later (`takerBuyVolume`, missing from 606,161 of 606,605 production candles) therefore stayed missing forever. A `refill` option re-fetches the whole window and lets the upsert patch every row
- Container cron log had grown to 60MB in the container's writable layer with no rotation; the crontab now truncates it in place above 10MB
- `e2e/signals.spec.ts` matched its gauge branch with `locator('svg')`, which also matched sidebar nav icons, so under full-suite load two branches of the `.or()` chain resolved at once and Playwright raised a strict mode violation. Scoped to the `signal-gauge` test id

### Fixed (post-deploy)
- Snapshot upserts replaced the whole `data` object, so any writer that supplied a subset of fields erased the rest. The admin snapshot backfill supplies only funding, long/short, open interest, and Fear & Greed, which means running it would have deleted live-captured `newsSentiment` (unrecoverable, since RSS has no history) on up to 500 recent bars per symbol and interval. `bulkUpsertSnapshots` and `upsertSnapshot` now set each data field by its own path and keep fields a write does not supply. This also stops a failed news fetch at :15 from erasing news stored by the :00 ingest of the same hourly bar
- Top-symbol selection for monthly optimization had never worked in production. Production sets `BINANCE_API_URL` to `https://api.binance.com/api/v3`, as documented, and `top-symbols.ts` appended `/api/v3` again, so every run hit a 404 and silently used the hardcoded fallback. Fixing the URL alone would have been worse: the raw USDT volume ranking is led by stablecoin pairs (USDCUSDT first, USD1USDT seventh on 2026-09-16), and styles take symbols round-robin, so scalping would have optimized on USDCUSDT. Selection now ranks `SIGNAL_SYMBOLS` by 24h volume through the shared `fetchTickers` client, which also guarantees every chosen symbol has stored snapshots
- A style that failed during monthly optimization left its `OptimizationJob` document in `running` indefinitely; only the `CronRun` entry was marked failed. The job is now closed as `failed` with the error message
- CryptoSlate's feed returns 403 to the production VPS IP range regardless of user agent (it answered 200 from a residential connection), so every five-minute feed refresh logged a failure. Replaced with The Block, verified reachable from the VPS. CoinDesk now uses its canonical feed URL, avoiding a 308 redirect

### Changed (production activation)
- News now comes from publisher RSS feeds (CoinDesk, Cointelegraph, Decrypt, The Block) instead of CryptoPanic, whose free Developer plan was discontinued: `/api/developer/v2/` returns a 404 HTML page and the remaining plan segments are paid. Production had recorded no news sentiment for over a week as a result. The feeds need no credentials, and `fetchCryptoNews` keeps its signature so snapshot ingestion, the news route, and the NewsFeed component are unchanged. The merged feed set is now cached once rather than once per symbol, replacing ten upstream calls per snapshot cycle with one. Per-symbol relevance is matched from headline and body text with word boundaries, since RSS carries no currency tags. `CRYPTOPANIC_API_TOKEN` removed from `.env.example`
- RSS carries only a current page, so there is no historical news backfill. News coverage in `HistoricalSnapshot` begins at the swap date, which limits the News signal's contribution to backtests until history accumulates
- Admin `months` bounds raised from 12 to 48 on the monthly optimization trigger and snapshot backfill, so a daily-bar window can actually be requested
- Monthly optimization is scheduled by the server crontab only. `.github/workflows/monthly-optimization.yml` removed: it had failed on schedule every month since April 2026 because the `PRODUCTION_URL` and `CRON_SECRET` repo secrets do not exist, and the container crontab now covers the same job

### Added (production activation)
- `POST /api/admin/backfill-candles`: admin-gated candle backfill and repair, mirroring the snapshot backfill (symbols, intervals, months, plus `refill`). Restricted to 15m/1h/4h/1d because 1m and 5m carry a 7-day and 14-day TTL, so history fetched beyond that is deleted again by the TTL index. Reports `takerBuyVolume` coverage per pair, since a refill patches rows without inserting any and therefore reports `inserted: 0` on success

### Added (trader psychology)
- Journal entries carry structured psychology fields: emotion (calm, confident, anxious, FOMO, revenge, tired), mistakes (chased entry, oversized, no stop, moved stop, exited early, held too long, ignored plan), conviction level (1-5), and planned risk:reward. Entry forms capture emotion, conviction, and planned R:R; the close-trade dialog captures mistakes
- Journal analytics gains win rate by emotion, cumulative cost per mistake type, and per-trade streaks (current run, best win run, worst loss run), shown in a Psychology card
- Advisory discipline engine (`src/lib/discipline.ts`): loss-cooldown warning at 3 consecutive losses, tilt-sizing hint at 2, revenge-trade detection (re-entering a symbol within an hour of closing it at a loss), and overtrading detection (today far above your recent daily average). Surfaced as non-blocking banners on the signals page and inside the journal entry dialog; input is a generic trade list so paper-bot trades can feed it later
- Suggested position size from your real trade record (half Kelly), greyed out until 20 closed trades with both wins and losses
- Per-tier accuracy hint beside the signal gauge ("your strong buy record: 62% win rate over 24 journaled trades"); informational only, scores and tiers stay objective

### Added (order flow and news sentiment)
- Taker buy volume parsed from Binance klines (index 9) and stored on candles; legacy stored candles lack it until re-synced or backfilled (upserts refresh in place)
- Taker Flow signal in the volume category: taker buy share of volume above 0.55 reads bullish (aggressive buying), below 0.45 bearish, silent in the indifferent band and on candles without the data. Present in live signals and both backtest engines with no-lookahead and parity coverage
- Keyword news sentiment as a News signal in the sentiment category (directional, minimum 3 articles and a clear tilt), riding alongside the contrarian Fear & Greed read. Live signals read the latest stored snapshot per symbol (no news API calls at compute cadence, 2 hour staleness cap); backtests receive it through the existing point-in-time snapshot series
- Both inputs fold into existing weight categories, so the walk-forward optimizer covers them without any weight-schema changes

### Added (multi-timeframe and sessions)
- Higher-timeframe confluence as a seventh signal category (`htf`): a compact trend assessment (EMA cross, price vs SMAs, SuperTrend) of the confirmation timeframe (1m to 15m, 5m to 1h, 15m/1h to 4h, 4h to 1d), computed from the last closed HTF bar only. Live signals, both backtest engines, and walk-forward optimization all consume it; the weight is optimizer-searchable per style
- Default weights rescaled so an empty htf component reproduces pre-htf scores exactly via weight redistribution (invariance covered by test); pre-htf template docs read back with htf 0
- Market session taxonomy (Asia, London, London/NY overlap, New York, off hours; fixed UTC): recorded on GlobalSignal at candle close for intraday intervals, applied as an entry-only filter in backtests (`allowedSessions`), reported as per-session performance breakdown in backtest metrics and UI, and added to journal analytics (by session, by hour, by weekday, all UTC)
- GlobalSignal documents carry `session`, compact `htfContext`, and `configVersion: 2`; the signals page shows HTF trend and session chips; the backtest config panel gains session toggles
- No-lookahead guards extended to HTF: alignment maps each low-timeframe bar to the newest closed HTF bar only, with causality and truncation tests

### Fixed
- Robustness filter compared absolute-currency drawdown against a fractional threshold, rejecting every optimization candidate and crashing the ensemble; it now uses `maxDrawdownPercent / 100`
- Ensemble read nonexistent `sortino`/`calmar` metric keys, so `avgSortino` was always 0; keys corrected to `sortinoRatio`/`calmarRatio`
- Walk-forward ensemble and the auto-activation Sharpe gate now judge on out-of-sample test results; previously a weight-based `findOne` returned in-sample training docs
- Out-of-sample test windows are now warmup-prefixed; previously the 100-bar test slice was smaller than the indicator warmup and would throw (masked by the drawdown bug skipping every window). Training windows are also floored at the style's minimum candle requirement
- `pnlPercent` unified between the two backtest engines (net of fees, relative to entry notional); the optimized engine previously reported gross price change
- Monthly orchestrator now marks ensemble contributors via `markResultsAsContributors` (previously only the admin route did)
- Snapshot backfill stamps point-in-time daily Fear & Greed (real alternative.me history, carry-forward max 3 days) and carries funding rates forward from the last settled event; previously all historical bars received the current Fear & Greed value
- Monthly optimization schedule added to `docker/crontab.template`; the GitHub Actions trigger had failed every month since May 2026 because the `APP_URL`/`CRON_SECRET` repo secrets are empty

### Added
- Backtests score with point-in-time futures and sentiment from `HistoricalSnapshot`, matching live signal composition; futures/sentiment weights are now learned from data instead of being redistributed away. Runs disclose `snapshotCoverage` (percent of scored bars with data)
- `snapshot-series` module: pure point-in-time alignment of snapshots to candles (no-lookahead, staleness-capped, adapter to exact live scorer input shapes)
- Walk-forward, monthly orchestrator, admin optimization, and the backtest UI all thread the snapshot series through both engines; the UI shows a coverage line and degrades gracefully when the fetch fails
- `fetchFearAndGreedHistory` (alternative.me daily history, Redis-cached) and `startTime`/`endTime` params on `fetchFundingRate`
- No-lookahead regression tests (indicator, score, and snapshot paths), cross-engine parity tests, shared `trade-utils` unit tests, and a walk-forward integration test on mongodb-memory-server
- Backfill response reports per-field coverage counts

### Changed
- Volume interpreter is directional: high volume confirms the bar's direction instead of always reporting neutral; low volume reads as low conviction
- ATR now acts as a volatility regime input: excluded from the volatility category's directional mean (it always diluted the score toward 0) and extreme/moderate regimes subtract up to 15 confidence points
- Consolidated the duplicate sentiment stack into `src/lib/external/` (Redis-cached, timeouts); keyword scoring moved to `external/news-sentiment.ts`; deleted `src/lib/sentiment-analysis.ts`
- Walk-forward accepts an injectable robustness config (used by the integration test)
- `mongodb` and `@testing-library/dom` declared as direct dependencies (previously undeclared transitive imports that broke clean installs)

## [1.0.0] - 2026-06-07

### Added
- Promotional, public-facing README with hero image, status badges, and a live demo link
- `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1)
- IDE and editor ignore entries in `.gitignore`
- `SEED_EMAIL` and `SEED_PASSWORD` documented in `.env.example` (both are required by `npm run seed`)
- Email verification on registration with a hard login gate (unverified credentials accounts cannot sign in; OAuth accounts are auto-verified)
- Resend-verification and password-reset flows (forgot-password and reset-password pages and API routes)
- Restored registration form with Terms-of-Service acceptance
- Cloudflare Turnstile protection on the registration, resend, and forgot-password endpoints
- Transactional email via MailerSend SMTP (nodemailer)

### Removed
- Internal dev-process docs from the public repo (`sessions/`, `plans/`, `PLAN.md`, `SHIPPING.md`); now gitignored

### Fixed
- DataStatus component now auto-fetches candle counts on mount and when symbol/interval changes (removed manual "Check Status" button)
- E2E signals tests updated for CardTitle div elements (getByRole('heading') to getByText())
- Null assertion crash in monthly-orchestrator when `getCandleRange` returns null `newest` value
- Silent error swallowing in compute-engine bulk insert fallback -- now logs errors and adjusts computed/errors counts
- Registration race condition: concurrent duplicate email now returns 409 instead of 500 (MongoDB error code 11000)
- Unused variable lint warning in walk-forward.ts (`testDoc`)

### Changed
- Standardized button sizes: replaced `size="sm" className="h-7 text-xs"` overrides with `size="xs"`, `size="icon-xs"` variants across all pages
- Replaced hardcoded hex colors (#0ecb81/#f6465d, text-green-400/text-red-400) with CSS variable classes (text-bullish/text-bearish) in ~18 components
- Replaced `text-[10px]` with `text-xs` (12px) across ~26 components for readability
- Standardized Card/CardHeader/CardContent usage on Signals, Backtest, and Research pages; added consistent `p-4` page padding
- Strengthened weak test assertions: replaced `.toBeDefined()` with type/range/enum checks in compute-for-style, compute-engine, and scorer tests
- Removed conditional guard in E2E dashboard watchlist test that silently skipped assertions
- Exported `calculateWindows` from walk-forward.ts for direct unit testing

### Added
- `LICENSE` (MIT), backing the license declared in the README
- `SECURITY.md` with a private vulnerability-reporting policy
- `CONTRIBUTING.md` documenting local setup, required checks, and Conventional Commits
- `package.json` metadata: `description`, `author`, `license`, `repository`, `homepage`
- README disclaimer section (educational project, not financial advice)
- Unit tests for walk-forward `calculateWindows` (8 tests: boundaries, anchoring, expanding, step size)
- Unit tests for template-versioning (7 tests: versioning, activation, deactivation, error handling)
- Unit tests for monthly-orchestrator (5 tests: happy path, insufficient data, backfill, null regression, empty candles)
- Regression test for BUG-1 null `range.newest` in orchestrator backfill check
- Test for BUG-2 individual insert failure count adjustment in compute-engine
- Tests for BUG-3 duplicate key (11000) and non-duplicate error handling in registration route

### Fixed (previous)
- Middleware blocking logo and icon static assets
  - Updated matcher pattern to exclude logo.png, icon.png, opengraph-image.png, apple-icon.png
  - Fixed Next.js Image optimization 400 errors preventing logos from displaying
  - Logo now displays correctly in navbar, footer, sidebar, and auth pages
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
  - Removed dead Blog and Docs links from navigation bar and mobile menu
  - Replaced dead Blog and Documentation links in Footer with Features and How It Works

### Added
- **Phase 14: Enhanced Signal System with Per-Style Differentiation**
  - Per-style indicator config profiles (scalping, day trading, swing, position) with differentiated EMA, RSI, MACD, Bollinger, ATR, StochRSI, Ichimoku parameters
  - Style-aware indicator computation wrapper (`computeIndicatorsForStyle`)
  - High-frequency candle intervals (1m, 5m) with TTL-based auto-cleanup
  - GlobalSignal model for shared, pre-computed signals per symbol/style/interval
  - Batch signal compute engine with candle deduplication across styles
  - Top 10 symbols configuration (BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK)
  - Per-style cron scheduling (1min scalping, 5min day trading, 15min swing, hourly position)
  - Global signal API routes (`/api/signals/global`, `/api/signals/latest`)
  - Client hooks (`useGlobalSignals`, `useLatestSignals`, `useLatestSignalForStyle`, `useComputeGlobalSignal`)
  - Enhanced signals page UI with style tabs, auto-update status bar, signal timeline sparkline, multi-style comparison cards
  - Backtest integration: walk-forward optimizer uses style-specific indicator configs
  - 132 new unit tests for Phase 14 features
- **Comprehensive Test Coverage and Bug Fixes**
  - Added 10 unit tests for cron sync-candles route (intervals parsing, dedup, limits, errors)
  - Added 7 unit tests for cron compute-signals global `?style=` path
  - Added 6 unit tests for prepareBacktest with style-specific indicatorConfig passthrough
  - Rewrote E2E signals spec: 15 tests covering style tabs, interval switching, 10 symbols, multi-style overview, auto-update status, signal history, compute button
  - Fixed register route: env-gated registration (`ALLOW_REGISTRATION=true`) replacing hardcoded 403
  - Fixed register page test: updated for redirect-to-login behavior
  - Fixed login page test: removed stale register link test
  - Fixed backtest engine degenerate test: aligned candle count with dynamic `computeMinCandles`
  - Fixed E2E auth tests: updated for registration-disabled register page redirect
  - 2044 unit tests passing (229 test files), 0 failures
  - 94 E2E tests passing, 0 failures

- **Phase 13D: Walk-Forward Optimization System**
  - Weight generator with constrained randomization (±20% from base template)
  - Seeded RNG for reproducible weight generation
  - Robustness filter for backtest results (Sharpe ≥ 0.5, win rate ≥ 40%, DD ≤ 30%, min 10 trades)
  - Ensemble system to average top N performers
  - Template versioning with manual activation requirement
  - Optimized backtest engine with pre-computed indicators (10-50x faster)
  - Walk-forward optimization using anchored expanding windows
  - OptimizationJob model with progress tracking
  - Admin API endpoints:
    - `POST /api/admin/optimize-template` - Trigger optimization
    - `GET /api/admin/optimize-template/:jobId` - Poll job status
    - `POST /api/admin/activate-template` - Activate optimized template
  - 37 new unit tests (all passing)
  - Automated discovery of optimal signal weights from historical data
- **Admin Optimization UI Dashboard** (`/admin/optimization`)
  - Comprehensive optimization dashboard with tabbed interface
  - Optimization form with validation (trading style, symbol, interval, months)
  - Real-time progress monitoring with live polling (2s intervals)
  - Progress bar, ETA calculation, and statistics display
  - Optimization history table with status badges and filtering
  - Template comparison view with side-by-side weight analysis
  - Performance metrics diff (Sharpe ratio, win rate improvements)
  - Visual weight bars showing changes from current template
  - One-click template activation with confirmation
  - Admin section in sidebar (visible when on admin pages)
- **E2E Tests for Optimization System** (`e2e/optimization.spec.ts`)
  - Comprehensive E2E test suite with 12 tests (3 passing, 9 skipped for non-admin)
  - Admin access control and redirect tests
  - Form field validation and parameter change tests
  - Tab navigation tests (Optimize, History, Compare)
  - Sidebar admin section visibility tests
  - Fixed Sidebar unit tests to mock next-auth/react useSession
- **Phase 13E: Automated Monthly Optimization**
  - CronRun model for tracking monthly optimization runs
  - Top symbols utility with Binance 24hr volume API and Redis caching
  - Auto-activation logic with 10% Sharpe improvement threshold
  - Monthly orchestrator running all 4 trading styles sequentially
  - Cron endpoints:
    - `POST /api/cron/monthly-optimization` - Cron trigger (CRON_SECRET auth)
    - `GET /api/cron/monthly-optimization/:cronRunId` - Status polling
    - `POST /api/admin/trigger-monthly-optimization` - Manual trigger (admin-only)
  - Vercel cron schedule (0 0 1 * *) - 1st of each month at 00:00 UTC
  - GitHub Actions workflow as fallback mechanism
  - Background job execution (no timeout issues)
  - Round-robin symbol distribution from top 5 by volume
  - Auto-activation when Sharpe improves by ≥10%
  - Comprehensive error handling and individual job failure tolerance
  - Admin UI for cron run management:
    - CronHistory component with expandable job details and status badges
    - TriggerOptimizationDialog for manual monthly optimization triggering
    - `GET /api/admin/cron-runs` endpoint for listing cron run history
    - "Cron Runs" tab in OptimizationDashboard (4-tab layout)
    - Conditional auto-refresh (5s) when runs are active
  - 110 new tests (all passing):
    - Unit tests (40 tests):
      - `top-symbols.test.ts` (17 tests) - API, caching, filtering, sorting
      - `auto-activation.test.ts` (14 tests) - Decision logic, threshold validation
      - `cron-run.test.ts` (9 tests) - Model validation, schema, updates
    - Integration tests (40 tests):
      - `api/cron/monthly-optimization/route.test.ts` (11 tests) - Cron trigger, auth, job creation
      - `api/cron/monthly-optimization/[cronRunId]/route.test.ts` (15 tests) - Status polling, progress
      - `api/admin/trigger-monthly-optimization/route.test.ts` (14 tests) - Manual trigger, validation
    - UI tests (30 tests):
      - `api/admin/cron-runs/route.test.ts` (8 tests) - Listing API auth, sorting, transform
      - `CronHistory.test.tsx` (14 tests) - Loading, empty, table, expand, badges, duration
      - `TriggerOptimizationDialog.test.tsx` (8 tests) - Form, submit, error, success callback
    - E2E tests (4 tests):
      - Cron Runs tab visibility, content, trigger button, dialog opening
- New environment variables:
  - `ADMIN_EMAIL` - Email address for admin authorization
  - `CRON_SECRET` - Bearer token for cron endpoint authentication
- New UI components:
  - Alert component for notifications and error messages
  - Progress component for progress bars
  - Form components (full react-hook-form integration)
- Badge success variant (green) for completed states
- Dependencies: react-hook-form, @hookform/resolvers, date-fns
- `holdTimeBars` field to BacktestTrade type for trade duration tracking
- Comprehensive Terms of Service (16 sections)
  - Service description and user responsibilities
  - Prohibited activities and data disclaimers
  - Intellectual property and liability limitations
  - Strong financial disclaimer ("not financial advice")
  - Third-party service integrations
  - Account termination and dispute resolution
  - Indemnification and severability clauses
- Comprehensive Privacy Policy (12 sections)
  - Detailed data collection and usage disclosure
  - GDPR rights (EU users) and CCPA rights (California users)
  - Data security measures and retention policies
  - Third-party integrations (Binance, OAuth, MongoDB, Redis)
  - Data breach notification procedures
  - International data transfer safeguards
  - Children's privacy protection
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
- Rebranded from "Crypto Portfolio Tracker" / "Crypto Tracker" to "CryptoWithAlgo" across all files, tests, and E2E specs
- Replaced Star icon with Zap icon (lucide-react) in nav, footer, sidebar, and auth layout
- Hero heading updated to "Algorithmic Crypto Intelligence / Powered by CryptoWithAlgo"
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
