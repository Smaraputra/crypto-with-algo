# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Verified (signal calibration, 2026-09-21): the 24/30 tier cutoffs stand on the archive dataset
- `scripts/research/score-percentiles.ts` re-run on the archive dataset (`e84cd66dbe01...`, ten symbols, lockbox applied, so every series ends 2026-06-30). The 2026-09-19 measurement was taken on a different export (hash `3fdeac9e...`, 2026-09-18, before the archive work), and a cutoff validated on one export is not automatically valid on another, which is the whole reason this re-runs rather than being assumed
- Pooled `|composite|` p90 / p98 / share above 24 / share above 30: 5m 22.7 / 30.4 / 8.1% / 2.2%, 15m 23.3 / 29.2 / 8.7% / 1.5%, 1h 25.4 / 30.6 / 13.6% / 2.5%, 4h 25.3 / 31.8 / 12.8% / 3.4%, 1d 25.3 / 33.2 / 12.3% / 4.1%
- Every interval reproduces within half a point at p90 except 1d, which moves furthest (p98 31.1 to 33.2, share above 30 from 2.9% to 4.1%) and is the interval the archive backfill changed most. Every share above 24 still lands in the 8% to 14% band the cutoffs were chosen for. **`TIER_BUY_CUTOFF` stays 24 and `TIER_STRONG_CUTOFF` stays 30**, which is the standing rule: cutoffs are measured on score distributions and decided by hand, never tuned on PnL. A change would break the continuity of the live outcome record for no measured gain. Table recorded in the header of `src/lib/signals/calibration.ts`

### Fixed (llm factor)
- The inputs packet (`src/app/api/admin/llm-calls/inputs/packet.ts`) bounded news only from above, at the last closed bar's close, so the ten news slots filled from the tail of the merged RSS feed once a symbol's recent stories ran out. Decrypt's feed carries evergreen video posts whose `pubDate` is months old and which sort last in `dedupeAndSort`, so the 2026-09-20 04:00 UTC panel run showed ETH four recent headlines followed by three Decrypt clips dated 2026-01-21 to 2026-01-23, and BNB and DOGE nothing but January clips, none of them about either coin. News now has a lower bound as well: `newsLookbackMs` keeps items published no earlier than the interval's decision horizon (`OUTCOME_HORIZON_BARS` for its trading style: 24 bars at 1h, 30 at 4h, 20 at 1d), floored at three days so a 1h packet is not cut back to one hour of coverage, and the survivors are sorted newest first before the cap so the ten kept are the ten newest whatever order the feed arrives in. Measured against the live feeds, this leaves ETH seven items and XRP and SOL four each, every one within three days, and BNB and DOGE empty, which the merged feed makes truthful: it holds no recent story about either. A packet's `inputsHash` changes wherever its news does, as intended; call idempotency keys on symbol, interval, `candleTimestamp`, and `promptVersion`, not on the hash
- Not fixed here, on purpose: `newsSentiment` in the packet's `snapshot` block is still computed over an unbounded window. `src/app/api/cron/ingest-snapshots/route.ts` scores whatever `fetchCryptoNews(ticker)` returns, up to its default of 20 items with no recency bound, so the same January clips pushed the stored `count` to 20 with `avgSentiment` near zero for symbols whose recent coverage is three or four stories. That field feeds the sentiment component of the composite, so bounding it changes stored snapshots and scored signals rather than only the packet, and belongs in its own change

### Research (Phase 4c, 2026-09-21): eight runs, eight failures, and one result worth keeping
- The two new families and the withdrawn Phase 4b positioning runs were all run on the VPS against dataset `e84cd66dbe01` with the lockbox applied, 10 symbols, 6 windows, and `--trials 342` fixed for the whole phase (Phase 4b used 486 and 360, which made its own runs incomparable). Reports `strategy-<family>-<interval>-p4c.json`, each schema-validated, each with one random symbol-window re-run via `--cell --report` and reproduced digit for digit. Full table in the header of `scripts/research/strategy-families.ts`
- All eight fail the gate set. `positioning-fade` 1d +0.752% (CI -2.144, timing p 0.055, 6 of 8 failed), `positioning-fade` 4h -0.217%, `positioning-horizon` 1d -1.488%, `positioning-horizon` 4h -0.164%, `funding-z-fade` 1h -0.143%, `funding-z-fade` 15m -0.075% (timing p 0.005), `depth-imbalance-fade` 4h +0.090%, `depth-imbalance-fade` 1h -0.078% (timing p 0.045)
- **The Phase 4b table is replaced, not annotated.** Both positioning families now read precomputed full-series columns instead of deriving a trailing window from the sliced `ctx.snapshots`. The numbers moved, which is the evidence the columns actually reach the families: the 1d fade went from +0.481% to +0.752% and its timing p from 0.070 to 0.055. The verdict did not move. The withdrawn numbers are not repeated in the header; they were not testing what their labels claimed
- **Three runs now clear the timing gate** (`funding-z-fade` 15m p 0.005, `depth-imbalance-fade` 1h p 0.045, with `positioning-fade` 1d just missing at 0.055), so for the first time a positioning-adjacent entry is distinguishable from entering at random with the same exit profile. Every one of them still loses money, which is the same verdict Phase 4 reached on the composite: the signal is worth less than the cheapest way to act on it
- **`depth-imbalance-fade` at 4h fails 5 of 8, the fewest any family has managed.** It is the first run to clear the symbols gate (7 of 10 positive) and the first with a positive point estimate that also survives the stress gate (+0.090% falling to +0.005% at 1.5x fees and 2x slippage). It fails on the confidence interval (-0.360), window consistency (0.467 against 0.6) and timing (p 0.144). Not an edge, but the only result in the program's history that fails for reasons resembling insufficient evidence rather than absent effect
- `depth-imbalance-fade` runs with `--start 2023-01-01`: the archive's depth column is populated on 78.1% of metrics rows and begins 2023-01-01 while candles begin 2018-10-31, so the unbounded run would fail for a data reason dressed as an edge reason

### Fixed (research): a trailing window meant two different things in-sample and out-of-sample
- `runStrategyWalkForward` prepares each window from a slice of the candle array, and `prepareBacktest` builds `ctx.snapshots` from that slice. Any family deriving its own trailing window therefore got the full window in-sample (the train slice is thousands of bars) and a truncated one out-of-sample (only `purgeGapBars` of pre-test history). The same grid cell labelled two different factors on the two sides of the split, so cell selection optimised one quantity while the gates scored another. Not lookahead: truncation is backward-only, which is why `no-lookahead.test.ts` never caught it
- Measured from the Phase 4b reports. At 1d the test slice is 612 bars, so a 720-bar window could never be realised at all, and the 1d positioning fade selected that cell in 5 of its 38 selecting symbol-windows (BTCUSDT in 2 of its 3). At 4h the slice is 1,845 bars, so a 720-bar window was truncated across the first 32% of each test window and a 360-bar window across the first 10%; the 4h fade selected 720 in 14 of 53 and 360 in 17
- **The Phase 4b table is superseded; it was re-run on 2026-09-21 and replaced (see Phase 4c above).** The verdict is unlikely to move (6 of 8 gates failed, CI -2.4% to +3.2%), but the run was not testing what its cell labels claim, so it is not evidence until re-run. Recorded in the header of `scripts/research/strategy-families.ts`

### Added (research): a research-only per-bar column channel
- `src/lib/backtest/research-series.ts`: `ResearchRow`, `ResearchBar`, `buildResearchSeries` (exact open-time join, no staleness carry) and `researchValue` (NaN, never 0, for a missing reading). `StrategyContext` gains `research`, under the same causality contract as `candles`. Threaded through `bar-loop.ts`, `optimized-engine.ts`, `strategy-walk-forward.ts` and `strategy-harness.ts`, including `runCell` so a spot check verifies the run it is checking
- Deliberately NOT part of `SnapshotBar`, whose shape is the live scorer's contract. Nothing in the channel reaches `computeSignalScore`
- `scripts/research/research-columns.ts` builds every column once over the FULL candle series, so preparing a window slice selects a sub-range instead of recomputing a shorter window. Snapshot-derived columns (funding, positioning) are open-aligned and unshifted; the depth column is close-aligned per `factors.ts` and then shifted forward one bar, which is both observable before the next bar's open and exactly the lag-1 relationship the surviving cells were measured at
- Columns are masked below the indicator warmup because `factors.ts` masks its raw series there. A test pins `fundingZ30d` equal to `raw.fundingZ` bar for bar, and another pins the depth column equal to `trailingZScore(raw.depthImbalance1)` shifted one bar. Without the warmup mask the two disagreed by more than 0.6 sd

### Added (research): two families on the untested lag-1 survivors
- `funding-z-fade` (15m, 1h) and `depth-imbalance-fade` (4h, 1h), both contrarian, both the same cheap rule shape the positioning families use so a difference in outcome is a difference in the input. New inputs, not new rule shapes over old ones, per the standing ruling
- `positioning-fade` and `positioning-horizon` now read the same columns rather than deriving their own z
- `StrategyFamily` gains `requiresResearchColumns`, and the harness aborts naming any symbol whose dataset produced none of them, instead of completing with the misleading "no cell reached N in-sample trades"

### Added (research): the lag-1 survivor table, and the execution-lag caveat
- `scripts/research/factor-ic.ts` carried a per-factor table for lag 0 only and bare counts for lag 1, leaving the superseded table as the only one to read. The lag-1 table is now in the header, generated from the reports with the repository's own `SURVIVOR_RULE`; its per-interval counts reproduce the recorded ones exactly
- Three lag-0 claims do not survive and must not be built on: `cat.futures` at 1d, `raw.fundingZ` at 4h, and `raw.depthImbalance1` at 1d. `raw.basisPct` and `raw.perpSpotSpreadPct` survive nowhere at either lag
- Recorded that the bar loop fills a market entry at the decision bar's own close, which is execution lag 0. Honest for a snapshot-derived factor (snapshots pin to the bar's open) and optimistic for a candle-derived one, so every recorded Phase 4 number for `control`, `return-reversal` and `oscillator-reversion` rests on an assumption the factor study has since abandoned

### Added (research): payoff ratio alongside win rate
- `PooledStats` and the report schema gain `avgWinPercent`, `avgLossPercent` and `payoffRatio`. Reported only: no gate reads them and nothing selects on them. Expectancy is `winRate * avgWin - (1 - winRate) * avgLoss`, so a win rate is uninterpretable without the payoff beside it and either can be bought at the other's expense. The objective stays net expectancy per trade after costs

### Research (Phase 4b, 2026-09-20): the positioning finding does not pay its costs
- Two rule shapes were built on the Phase 3b positioning result and run through the unchanged gates at 1d and 4h. All four runs fail. `positioning-fade` (trailing z of the top-trader long/short ratio, ATR stop, 2:1 target) and `positioning-horizon` (the same entry held to a fixed horizon with the stop kept out of the way). Table in the header of `scripts/research/strategy-families.ts`
- The 1d fade is the only run in the program's history with a positive post-cost point estimate (+0.481% per trade), but its interval spans -2.4% to +3.2%, 4 of 10 symbols are positive, and the result is carried by DOGEUSDT, LINKUSDT and SOLUSDT while BTCUSDT and ETHUSDT lose. Concentration, not edge
- The decisive gate is timing: random-entry p runs 0.07 to 0.70, so the entry signal is not distinguishable from entering at random with the same exit profile. `positioning-horizon` was built to test the obvious explanation, that the IC measures an h-bar return while the rule resolves on the path, and it came out worse, so that explanation is wrong. Per the program's standing ruling no third shape was tried
- Why a factor with ic -0.218 and t -5.9 behaves this way: the IC counts every bar and Newey-West fixes the t-statistic for overlap, but it cannot turn a highly autocorrelated factor into independent bets, and in-sample selection took the shortest hold on offer in every run where the IC is strongest at 32 bars
- `StrategyContext` gains `snapshots`, the whole aligned series under the same causality contract as `candles`. The study measured the long/short ratio by Spearman rank inside each symbol and the level's distribution differs far too much between symbols for a fixed threshold to test it (4h p95 runs 1.76 on BNBUSDT to 4.54 on DOGEUSDT), so a rule needs a trailing window rather than just the current reading

### Research (execution lag, 2026-09-20): half the intraday reversal is bid-ask bounce
- Every interval re-run with `--execution-lag 1`. Positioning is untouched to four significant figures at every interval (4h -0.0783 t -4.9 either way; 1d -0.2177 to -0.2194). Short-horizon return reversal loses a large part of its effect everywhere, between 23% at 5m and 82% at 1d, and `raw.ret1` stops surviving at 1d altogether. `cat.volume`, `sig.OBV`, `sig.Taker Flow` and `raw.takerBuyRatio` stop surviving at 1h
- The artifact call is settled, not suspected: `raw.perpSpotSpreadPct` at 5m h1 goes from ic 0.0689 t 61.0, the largest single cell anywhere in this program, to ic -0.0015 t -1.3 once the return starts one bar later. It was the shared spot close, entirely
- This qualifies the Phase 3 headline rather than overturning it: intraday mean reversion is real but roughly half of the measured effect is the bid-ask bounce. Any future measurement on this dataset should run at lag 1; the lag-0 tables are kept for continuity with Phase 3


### Added (research)
- `--execution-lag` on `scripts/research/factor-ic.ts`, threaded into `forwardReturns` in `scripts/research/ic-stats.ts` and recorded on the report as `executionLagBars` (optional, so older reports still validate; absent means 0). A lag of 0 reproduces Phase 3 and stays the default; a lag of 1 measures the forward return from the NEXT close, which is both what a rule acting on the signal could actually get and the fix for any factor that shares a price term with its own return. `--cell --report` inherits the lag from the report the way it already inherits symbols, window and lockbox
- The mechanism is pinned by a test: a pure random walk observed with independent noise on every print, with the noise itself used as the factor, produces a spurious |IC| above 0.3 at lag 0 and below 0.05 at lag 1. That is exactly the shape `raw.perpSpotSpreadPct` showed against `raw.basisPct`


### Research (Phase 3b factor study, 2026-09-20)
- Archive history ingested into production Mongo: `futuresmetrics` 4,958,239 documents and `perpcandles` 14,127,326 (klines and premium index across five intervals), ten symbols from 2022-01-01, about 2 GB with indexes. Snapshot coverage for the two fields Binance REST could not reach went from 11.1% to 77.8% at 1h and 7.0% to 48.7% at 4h and 1d for `longShortRatio`, and to 95.6% and 59.8% for `openInterest`. The long/short figure is capped by the archive's top-trader column being ~0% across 2022 and ~100% from 2023
- Factor study re-run on all five intervals, lockbox applied, dataset hash `e84cd66dbe01`, same survivor rule as Phase 3. Survivors per interval 5m 24 of 50, 15m 27 of 51, 1h 19 of 51, 4h 10 of 51, 1d 7 of 46, against Phase 3's 4 of 40 at 4h and 2 of 35 at 1d. Full table in the header of `scripts/research/factor-ic.ts`
- Headline: positioning. At 4h and 1d a higher top-trader long/short ratio precedes lower forward returns at every horizon measured, the largest effect the program has recorded (1d h32 ic -0.218 t -5.9 n 12,906; 4h h32 ic -0.078 t -4.9). Order-book depth imbalance at +/-1% runs the same way (1d h32 ic -0.101 t -5.2), `cat.futures` survives at 1d for the first time, and funding z-scored over 30 days is a consistent contrarian signal from 5m to 4h (1h h8 ic -0.024 t -7.1). Phase 3 flagged long/short at 1d on about 500 bars; this is 3.5 years across ten symbols
- `raw.perpSpotSpreadPct` is recorded as a suspected artifact rather than a finding. It shares `spot close[t]` with the forward return's denominator, the classic bid-ask bounce correlation, and `raw.basisPct` measures the same quantity from the independent premium index at about 40% of the magnitude at every interval. Perp factors need forward returns computed on perp closes before that column means anything
- None of this establishes that any of it pays costs: Phase 3 had 18 survivors at 1h and Phase 4 still found no family that beat the round trip. What is different is the horizon, which is where Phase 4b comes in


### Fixed (archive ingestion)
- The snapshot backfill filled `data.longShortRatio` from the archive's global account ratio (`count_long_short_ratio`) while every live caller (`ingest-snapshots`, `compute-signals`, `compute-engine`, `signals/compute`) fills that field through `fetchLongShortRatio`, which hits `/futures/data/topLongShortPositionRatio`. Backfilled bars therefore carried a different series from live-captured bars in the same field, and historical scoring diverged from live scoring in exactly the way `src/lib/backtest/snapshot-series.ts` refuses to. It now uses the top trader POSITION ratio (`sum_toptrader_long_short_ratio`). The global account ratio is still ingested and still reaches research, as its own `raw.globalAccountRatio` column. Found by tracing the live callers after the first production study run
- A partial export (`--datasets`, or a narrowed `--symbols`/`--intervals`) rebuilt `manifest.json` from only the files that run wrote, orphaning everything else on disk and leaving a dataset hash describing a fraction of the dataset. `mergeManifestFiles` now replaces rewritten entries by path and carries the rest over, so an incremental re-export is safe; an unreadable existing manifest is treated as absent rather than fatal

- `scripts/ops/ingest-archive.ts` ran out of memory on the bookDepth dataset. Each job downloaded every file into an array and ingested afterwards, so it held a whole job's files at once: harmless for metrics (about 35 KB decompressed per day) but fatal for bookDepth, where 1,723 days of roughly 2 MB each is about 3.4 GB against Node's 2 GB default heap. Found on the production run, which died with `FATAL ERROR: Reached heap limit Allocation failed` after 347 seconds. Each worker now downloads and ingests one file before taking the next, so a job holds at most `--concurrency` files however many days it covers, and two regression tests pin the behaviour: the first write must land before the last fetch resolves, and the peak in-flight count must not exceed the concurrency

### Added (archive cron)
- `GET /api/cron/ingest-archive` keeps `FuturesMetric` current from the archive, with a bounded window (`days`, 1 to 7, default 3), an optional `symbols` list and `depth=false` to skip the bookDepth pass. The window overlaps previous runs on purpose: every write is an idempotent upsert, so a day the archive published late is picked up by the next run rather than lost, and it never asks for today, whose file does not exist yet. Bulk history stays with `scripts/ops/ingest-archive.ts` from the seeder image
- A daily line in `docker/crontab.template`. Note the archive publishes a day late, so this is a history keeper, not a live feed: anything that graduates to live trading reads the REST endpoints in `src/lib/binance-futures.ts`, which serve the last 30 days and suffice once history is seeded

### Added (research factors)
- Eleven archive-derived columns in `scripts/research/factors.ts`, all in the existing `raw` category so `factor-ic.ts` discovers them, `report-schema.ts` validates them and `SURVIVOR_RULE` applies to them with no change: `raw.oiChange1`, `raw.oiChange8`, `raw.oiPriceDiv` (the buildup versus liquidation sign product), `raw.takerLongShortRatio`, `raw.topTraderPositionRatio`, `raw.globalAccountRatio`, `raw.fundingZ`, `raw.basisPct`, `raw.perpSpotSpreadPct`, `raw.depthImbalance1` and `raw.depthImbalance5`. `FactorMatrixInput` gains optional `metrics`, `perp` and `premiumIndex`; a dataset without them still loads and every archive column is NaN throughout, so an older export measures exactly what it always measured
- The 5m metrics grid joins each bar at its CLOSE, not its open, because a factor is read at the close and pinning to the open would discard most of an hour of information at 1h. This deliberately differs from `src/lib/backtest/snapshot-series.ts`, which is pinned to the open because live snapshot ingestion runs on its own cron. Perp bars join on an exact timestamp, so a missing perp bar is NaN rather than the previous bar's price
- `raw.fundingZ` uses a thirty-day trailing window rather than a bar count, because funding settles every 8h and a 96-bar window at 5m spans a single settlement with no spread. It is computed with running sums in one pass, and the variance carries a relative-epsilon guard: for a near-constant series `sumSq` and `count * mean^2` cancel almost exactly, and without the guard a flat funding rate produced a standard deviation around 1e-12 and an arbitrarily large z-score. No spread yields NaN, never 0, which would read as "exactly average"
- `scripts/research/factor-ic.ts` loads the new kinds in `loadSymbolData` and its header records what the Phase 3 table actually measured: in that dataset `raw.longShortRatio` had 11.0% coverage at 1h and none before 2026-03-03, and open interest never reached the scorer at all
- Verified end to end against live archive data on 2026-09-20: a BTCUSDT 1h dataset over 2024-01 to 2025-06 (13,128 bars, 157,409 metrics rows, 0 of 547 archive days missing) reproduces the Phase 3 finding, with `raw.rsi` the one survivor at sign -1 over horizons 1 and 4, while `raw.longShortRatio` is skipped outright as "no finite pairs at any horizon" over the whole eighteen months. That single-symbol run is a pipeline check, not a study result

### Added (research dataset)
- Two new dataset kinds in `scripts/research/dataset-format.ts`: `perp` (`PerpCandleRow`, carrying quote volume and trade count alongside OHLCV) and `metrics` (`MetricsRow`, every measure nullable). `ManifestFile['kind']` becomes `DatasetKind`; the dataset hash mechanism needed no change and picks the new files up on its own
- `scripts/research/export-dataset.ts` writes `perp/<SYMBOL>/<interval>.jsonl.gz` (the traded series keeps the bare interval name, others are suffixed, e.g. `1h.premiumIndex.jsonl.gz`) and `metrics/<SYMBOL>/5m.jsonl.gz`, one metrics file per symbol rather than per interval because the archive publishes a single 5m grid that every interval's factors align onto. New `--datasets` flag selects which kinds to write, so a partial re-export stays cheap, and `--perp-series` selects which perpetual series to export (default: the traded one only)
- `loadPerp` and `loadMetrics` in `scripts/research/load-dataset.ts`, applying the same lockbox cut as the other three loaders

### Added (archive ingestion)
- `PerpCandle` (`src/lib/models/perp-candle.ts`): USDT-M perpetual bars from the archive, series `klines`, `premiumIndex` or `markPrice`, unique on symbol, interval, series and bar. A separate collection rather than a `venue` field on `Candle`, whose unique index covers millions of documents on the live path and would need an index rebuild in production for no live benefit. Nothing in the live signal path reads it; it exists so research can price the venue it actually trades, because `Candle` holds SPOT bars while every backtest charges perpetual fees, slippage and funding
- `FuturesMetric` (`src/lib/models/futures-metric.ts`): open interest, top-trader account and position ratios, the global account ratio, the taker long/short volume ratio, and aggregated book-depth imbalance, on the archive's native 5m grid, unique on symbol and timestamp. Every measure is optional so a gap stays distinguishable from a real zero, and the metrics and bookDepth passes merge into the same document per slot with a field-level `$set`
- `src/lib/archive-ingestion.ts`: the pure shaping rules, with no fetch, Mongo or filesystem, so they are unit tested directly. File enumeration per cadence, bookDepth folded onto the 5m grid (each band averaged only over the snapshots that carried both of its sides), upsert builders that drop a null field rather than writing zero, a linear last-at-or-before aligner with a staleness cap, and the HistoricalSnapshot patch builder
- `scripts/ops/ingest-archive.ts`: the CLI, structured like `backfill-history.ts` with a pure `parseArgs`/`buildJobs`, one JSON line per job on stdout, and `main(): Promise<number>`. Datasets `metrics`, `bookDepth`, `klines`, `premiumIndex`, `markPrice`, `fundingRate` and `snapshots`; bounded-concurrency downloads; idempotent bulk upserts on each collection's unique key. The `snapshots` job is always ordered last because it reads back the `FuturesMetric` rows a `metrics` job in the same run has just written
- The `snapshots` job is the point of the phase: it fills `HistoricalSnapshot.data.longShortRatio` and `.openInterest`, the two fields `src/lib/snapshot-backfill.ts` could never backfill, taking them from 11.0% coverage after 2026-03-03 to the full span the archive reaches. `longShortRatio.ratio` takes the global account ratio, the same series the REST `globalLongShortAccountRatio` endpoint serves, so backfilled and live-captured bars measure the same thing, with `longAccount` and `shortAccount` derived as shares summing to 1. A patch is stamped at the bar and uses the last metrics row at or before that bar's own open time, never a later one, which is one notch stricter than live ingestion. Only those two fields are written, so live-captured news and Fear and Greed on the same bars survive
- `perpcandles` and `futuresmetrics` added to the default `COLLECTIONS` in `scripts/ops/sync-prod-to-local.sh`, so a synced local database is not silently thinner than production

- `src/lib/external/binance-archive.ts`: a client for the Binance public data archive (`https://data.binance.vision`), the only reachable source of multi-year USDT-M perpetual history. The REST endpoints in `src/lib/binance-futures.ts` serve `futures/data/*` for roughly the last 30 days (`RECENT_FUTURES_LIMIT` in `src/lib/snapshot-backfill.ts`), which is why stored `longShortRatio` and `openInterest` cover 11.0% of 1h bars and 6.9% of 4h/1d bars, all of it after 2026-03-03. The archive carries the same series at 5m resolution back to 2021, and it is reachable without the VPN that `fapi.binance.com` needs. Supports `metrics`, `klines`, `premiumIndex`, `markPrice`, `fundingRate` and `bookDepth`, with URL and cache-path builders, a zip reader, a fetcher (retry with backoff on 5xx and network errors, no retry on other 4xx, `null` rather than a throw on 404, an on-disk zip cache that also remembers a 404 as an empty file), and one typed parser per dataset
- Verified against live archive files on 2026-09-20: `bookTicker` serves no files for UM futures (404 across 2022 to 2025, daily and monthly), so order-book work goes through `bookDepth` instead; the session 07 handover's mention of bookTicker is wrong. `aggTrades` is deliberately unsupported, at about 408 MB per symbol-month, because the taker imbalance it carries is already in the kline row's `taker_buy_volume`
- Two shape gotchas the parsers handle: kline files written before about 2024 carry no header row (`BTCUSDT-5m-2021-11` starts at `1635724800000`) while later ones do, so the header is detected rather than assumed; and archive timestamps come in two forms, epoch milliseconds on kline and funding files and `YYYY-MM-DD HH:MM:SS` in UTC on metrics and bookDepth. The archive `fundingRate` shape (`calc_time, funding_interval_hours, last_funding_rate`) is not the REST `/fapi/v1/fundingRate` shape and carries no mark price. `bookDepth` levels are cumulative outward from mid, negative percentages on the bid side, so `depthImbalance` reads notional at the matching band and returns null when either side is absent
### Fixed (ops)
- `getLiveTierExpectancy` (`src/lib/signals/outcome-analytics.ts`) matched on trading style, status, and source but never on interval, while every style scores more than one interval (`STYLE_CONFIGS` preferredIntervals: scalping 1m and 5m, day_trading 15m and 1h, swing_trading 4h and 1d) and writes outcomes for each with the style's `horizonBars`, so a scalping 1m row is a 12-minute forward return and a 5m row a 60-minute one. `scripts/ops/live-outcomes.ts` then labeled the pooled result with the style's primary interval and its cost: the first production read (2026-09-18 to 2026-09-19) showed 15,392 resolved scalping rows in one day, which 5m alone (288 bars, ten symbols, at most 2,880 rows) cannot produce, so about five sixths of the "5m, 12 bars" line were 1m outcomes. `interval` is now a required option of `getLiveTierExpectancy`, and `live-outcomes.ts` reports one block per style, interval, and source (preferredIntervals order, composite before llm) with status counts, resolved range, and tiers all filtered to that interval. `defaultCostPercent` takes the interval (0.20% at 1m and 5m, 0.16% at 15m and 1h, 0.14% at 4h and 1d), and a new `--interval` flag keeps one interval's block per style. Live reads taken before this change are pooled across intervals and should not be compared with reads taken after it
- `scripts/ops/sync-prod-to-local.sh`'s default `COLLECTIONS` list omitted `signaloutcomes`, so a synced local database had no outcome rows and `scripts/ops/live-outcomes.ts --mongo-uri ...` printed zeros locally. `SignalOutcome` pluralizes to `signaloutcomes` (a regular mongoose pluralization); it is now part of the default list and the header's collection note
- Every production candle job reported `complete: false`: the flag compared the first stored bar's timestamp against the raw requested instant, but Binance returns bars aligned to the interval, so the first bar is always a little after that instant. `scripts/ops/backfill-history.ts` now compares against `alignedRequestedFrom` (the first bar-open time at or after the requested instant), logged alongside the existing `requestedFrom`

### Fixed (optimization)
- `WALK_FORWARD_FEE_PERCENT` (`src/lib/optimization/walk-forward.ts`) was the 0.1% Binance spot taker fee, applied per side to every production walk-forward backtest and to `deriveVolatilityStops`, while the research harness measured every strategy family against the USDT-M futures taker fee of 0.05% (`BINANCE_FUTURES_TAKER_FEE`, `src/lib/backtest/cost-model.ts`), the venue the program fixed. The stop floor of five round-trip fees was therefore 1% in production and 0.5% in research. The constant now reads `BINANCE_FUTURES_TAKER_FEE`. No live behavior changes until a template is activated (`OPTIMIZATION_AUTO_ACTIVATE` stays false). The next monthly optimization sees futures fees and a 0.5% floor. Left as they are, on purpose: `DEFAULT_BACKTEST_CONFIG.feePercent` (0.1%, the UI backtest fallback, a product default) and the production optimizer's lack of a slippage budget, which the study cost model has
- Stale comment in `src/lib/backtest/strategies/score-threshold.ts` said the score-threshold strategy was not wired into either engine. It is the default of `optimized-engine.ts` and the Phase 4 `control` family

### Added (research toolkit)
- `scripts/research/score-percentiles.ts` measures the live composite score distribution on the research dataset: |composite| p50, p90, and p98 plus the share of bars strictly above `TIER_BUY_CUTOFF` and `TIER_STRONG_CUTOFF`, per symbol and pooled, for every interval in the manifest. Bars are scored through `computeFactorMatrix` (default weights, the snapshot at or before the bar, Ichimoku skipped for scalping as live), only bars that carry a snapshot are kept unless `--include-no-snapshot` is given, and the lockbox applies unless `--allow-lockbox` is given. `--intervals`, `--symbols`, `--dataset-dir`, `--json`. `loadSymbolData` is exported from `factor-ic.ts` for it. The constants in `src/lib/signals/calibration.ts` are not changed by the script, a cutoff change is decided by hand from its table

### Fixed (research toolkit)
- `scripts/research/factor-ic.ts` forced snapshots null at 5m/15m (`NO_SNAPSHOT_INTERVALS`), skipping `cat.futures`, `cat.sentiment`, `raw.fundingRate`, `raw.longShortRatio`, and `raw.fearGreed` at those intervals, which diverged from live scoring (`mapToSnapshotInterval` maps them to the 1h snapshots through `src/lib/backtest/snapshot-series.ts`) and from `scripts/research/strategy-harness.ts`, which already loads the 1h file for them. It now loads `snapshots/<symbol>/<mapToSnapshotInterval(interval)>.jsonl.gz` when that file exists, for every interval, falling back to null with a stderr note when it does not. The Phase 3 factor study's 5m results (header of this file) predate the fix and were measured with snapshots forced null

### Added (llm factor)
- `LlmCall` model (`src/lib/models/llm-call.ts`): one document per symbol, interval, closed bar, and prompt version, with a unique key on that tuple so a repeated run is idempotent. Records a forward-only LLM panel factor measured the same way as the composite, by the outcome resolver; nothing in the scorer reads this collection
- `SignalOutcome.source` (composite by default, llm for panel calls); `createPendingOutcomes` and `getLiveTierExpectancy` take it, legacy rows read as composite
- `live-outcomes.ts --source composite|llm|all` (default composite): filters status counts, resolved range, and tiers by source; `all` reports both blocks per style, composite then llm, and the header line now prints `source=`
- `LLM_PANEL_SECRET` bearer secret for the admin LLM panel routes, separate from the cron containers' `CRON_SECRET`. `verifyCronSecret` generalized into `verifyBearerSecret(req, secret)` (unchanged behavior) with `verifyLlmPanelSecret` built on it (`src/lib/cron-auth.ts`); `authorizeLlmPanel` (`src/app/api/admin/llm-calls/auth.ts`) checks the panel secret first, falling back to the admin session via `requireAdmin`
- Point-in-time inputs packet route (`GET /api/admin/llm-calls/inputs`, `src/app/api/admin/llm-calls/inputs/route.ts`), built by a pure, dependency-injected `buildInputsPacket` (`inputs/packet.ts`) so it is tested without Mongo or the network. For a symbol and interval (1h, 4h, 1d) it returns the last closed bar, its trailing closes, the latest global signal and history snapshot at or before that bar's close, and news published at or before it; nothing in the packet can postdate the close of the last closed bar. `inputsHash` is a sha256 over the packet body excluding `generatedAt`, so a repeated request for the same bar hashes identically; it identifies the packet the voter saw, but the packet itself is not persisted. A news feed failure yields an empty list rather than failing the request; 400 on a bad symbol or unsupported interval, 404 when no closed bar is stored, 401 (500 when `ADMIN_EMAIL` is unset) via `authorizeLlmPanel`
- `POST /api/admin/llm-calls` (`src/app/api/admin/llm-calls/route.ts`) creates a panel call via `createLlmCall` (`create-call.ts`): `checkFreshness` rejects an unaligned candle timestamp, a bar not yet closed, and a bar closed more than two intervals ago, before anything is written. The call is idempotent on (symbol, interval, candleTimestamp, promptVersion), including a duplicate-key race on the unique index; a repeated post returns the stored call unchanged with `created: false` (200) instead of 201, and writes no second outcome. A new call also writes one pending `SignalOutcome` with `source: 'llm'`, `score` from `signedStrength(tier, strength)`, and `configVersion` set to the prompt version's number (`promptVersion` is validated as `vN`; `v1` writes 1), resolved the same way as the composite. Llm outcomes therefore carry the prompt version number in `configVersion`, so rows from the overlap window after a prompt bump are separable. `GET /api/admin/llm-calls` lists calls newest first with optional `symbol`/`interval` filters and a limit clamped to 200

### Fixed (signal outcomes)
- `resolveDueOutcomes` marked an outcome unresolvable the instant its candles were incomplete at `resolveAt`, racing the sync-candles cron that runs on the same 15-minute tick (`docker/crontab.template`). Measured in production on 2026-09-18: of 14,750 outcomes, 1,083 (7.3%) were unresolvable, spread across all ten symbols and concentrated on 15m (468), 5m (479), 1m (96), 1h (40); every one had `resolvedAt` within one minute of `resolveAt`, meaning the resolver's read beat the sync's write for the bar that closes at `resolveAt` by seconds, while resolved outcomes tolerated lag up to 757 minutes. The entry-missing, forward-candles-short, and non-consecutive-candles branches now only give up once a full interval of grace has passed beyond the outcome's own `resolveAt`; before that they are left pending for the next tick to retry

### Added (ops)
- `scripts/ops/live-outcomes.ts` reads the live signal outcome record: per-tier gross/net expectancy from `getLiveTierExpectancy` (its first caller), status counts, and resolved-date coverage, per trading style or across all four, with an optional symbol and `since` filter, a table or `--json` output, and a per-style default round-trip cost estimate (`defaultCostPercent`) that `--cost` overrides. Since the backtest track closed with no passing rule, this is the primary way to read the program's live evidence, runnable inside the seeder image against production or locally with `--mongo-uri`

### Changed (research findings)
- Tier cutoffs re-measured on refilled bars and all ten symbols (`scripts/research/score-percentiles.ts`, dataset `3fdeac9e…`, lockbox applied, one snapshot per bar, 24 s for five intervals). Pooled |score| p90 and p98: 5m 22.6 and 30.3 (808,517 bars), 15m 23.0 and 28.7, 1h 25.1 and 30.1, 4h 24.7 and 31.2, 1d 25.1 and 31.1. Share of bars above 24 runs 8.0% to 12.9% and above 30 runs 1.2% to 2.9% across intervals, with per-symbol p90 from 21.2 to 27.5. Every value sits within about one point of the 2026-09-16 measurement at p90 and two at p98, which was taken on bars stored before the candle-finalization fix and on five symbols, so `TIER_BUY_CUTOFF` 24 and `TIER_STRONG_CUTOFF` 30 stand and the table is recorded in the header of `src/lib/signals/calibration.ts`. The dataset carries a snapshot on every bar back to 2021-10 at 1h and 2018-10 at 4h and 1d, so the measurement covers the whole pre-lockbox history rather than the 2026-03-04 onward window the header's first measurement had

### Changed (research findings)
- `control-limit` rerun on the widened offset grid at 1h and 5m (trials 129): the selection moved to 20 and 30 bps and out-of-sample expectancy did not improve (1h -0.033% per trade with the interval spanning zero, 5m -0.114%), both still failing with timing p 0.005. Conclusion of the backtest track: no rule built from the current inputs, with market or resting-limit entries, pays for its costs at any interval

### Changed (research findings)
- Limit-entry variants run through the harness (`control-limit` at 5m and 1h, `return-reversal-limit` and `oscillator-reversion-limit` at 5m, trials 123, every report validated and spot-checked): the maker entry recovers 0.04 to 0.07% per trade against the market versions and every run still fails, with entry timing beating random entries (p 0.005) in all four. `control-limit` at 1h is the closest result so far (-0.022% per trade, interval spanning zero, positive in 2023 and 2024). Every `control-limit` window selected the deepest offset in the grid, so a wider offset grid is the one cheap follow-up left; table in the header of `scripts/research/strategy-families.ts`

### Changed (research findings)
- Phase 4 strategy validation run through `scripts/research/strategy-harness.ts` on the full production history (dataset `3fdeac9e…`, lockbox applied, ten symbols, study costs, trials 82): fourteen family and interval runs, every report schema-validated with one random window per report re-run and reproduced exactly. No family passes the gate set at any interval; the table and reading are in the header of `scripts/research/strategy-families.ts`. At 5m every family loses about the round-trip taker cost with tight intervals, at 1h control's entry timing beats random entries (p 0.005) but not by the cost, fading the composite is worse than random, at 4h control sits at breakeven, and at 1d both rules lose more than 1% per trade. The next experiment is maker-only limit entries for the three intraday families whose timing beats random

### Changed (research findings)
- Phase 3 factor study run on the full production history (dataset `3fdeac9e…`, lockbox applied, ten symbols, four intervals, one Sonnet agent per interval, every report schema-validated with a random cell re-run and reproduced exactly). Survivor table and reading transcribed into the header of `scripts/research/factor-ic.ts`. Headline: intraday (5m, 1h) every trend-following input, the composite score included, predicts forward returns with the wrong sign, and mean reversion dominates (past returns, RSI, and buying pressure precede lower returns; oversold Williams %R and Bollinger readings precede higher ones); at 4h only short-horizon momentum and 1 to 8 bar return reversal survive; at 1d only 1 bar reversal and the long/short ratio. The contrarian Fear & Greed mapping is on the wrong side at 4h and 1d. Effect sizes are small (pooled |ic| 0.02 to 0.05) and measured before costs. The live-history baseline could not be computed: `GlobalSignal` TTLs leave one day to thirteen weeks of history per style, so the outcome resolver from 2026-09-17 onward is the live record

### Fixed (e2e)
- `e2e/alerts.spec.ts` raced against itself under Playwright's three local workers: every authenticated test shares one user, and the create, pause/resume, and delete tests each acted on whichever alert item was first in the list, so the delete test could remove the alert the pause test had just paused and the pause test then waited on an untouched alert (the "flaky under load" note in earlier handovers was this race, not load). Each of the three tests now creates its own alert through the API and scopes every locator to that alert's `data-testid`

### Fixed (evaluation harness)
- Sharpe and Sortino annualized every interval with `Math.sqrt(252)`, the equities daily-bar convention. A 5m equity curve has 105,120 bars a year and a 1h curve 8,760, so the same return series scored a wildly different ratio depending on backtest interval, and the optimizer's `minSharpe` gate compared incompatible numbers across styles. `computeMetrics` now takes the backtest's `interval` and annualizes with `Math.sqrt(annualizationFactor)` (`barsPerYear(interval)`, derived from `intervalToMs` over a 365-day crypto year, since crypto trades every day unlike the 252-day equities convention). Sharpe and Sortino values stored before this change are not comparable across intervals or against values computed after it
- A limit order that filled and then, on that same candle, also breached its stop or target booked no loss until the following bar: the per-bar loop's stop/target check ran before the fill was possible to see. `runBarLoop` in `src/lib/backtest/bar-loop.ts` now checks the freshly opened position's stop and target against the same candle immediately after a limit fill (fill first, then stop/target, the conservative order), closing on that bar when either hits
- Funding was never accrued for the bar a position exited on: the per-bar loop only accrued funding for a position still open at the end of the bar, so every mid-loop exit (`stop_loss`, `take_profit`, `time_stop`, `signal`) silently dropped its own bar's crossing. `accrueFundingThisBar` in `bar-loop.ts` now runs before every `closeTrade` call, not only for a position that survives to the bar's close; `end_of_data` was already correct and is unchanged
- `closeTrade`'s `slippageCost` counted only the exit leg; the entry leg's slippage (already folded into `entryPrice` before sizing) was silently dropped. `openPosition` now takes the fill's pre-slippage price alongside the filled price, stores the difference as `OpenPosition.entrySlippageCost`, and `closeTrade` adds it into `BacktestTrade.slippageCost` alongside the exit leg. Zero for a limit fill, which never slips
- `random-entry-benchmark.ts`'s `entryProbability` divided trade count by every post-warmup bar, but `decideEntry` is only ever called on a bar the engine is flat. A random strategy built from that probability therefore entered less often than the reference whenever trades held for more than a few bars, understating its own trade count. `referenceProfile` now divides by the reference's flat-bar count (`totalBars` minus the sum of every trade's `holdTimeBars`, floored at 1), which measured about 1.7% off the reference's trade count on the engine-parity synthetic series, down from the previous ~30% tolerance
- `totalBacktests` on a saved template's `performanceMetrics` fed auto-activation's floor, but the admin optimize-template route wrote `ensembleResults.length` (capped at the top 5 by Sharpe) while the monthly orchestrator correctly wrote `gate.contributingWindows` (every window that produced an out-of-sample result). The route now writes `gate.contributingWindows` too, so both save paths report the same number auto-activation checks

### Added (evaluation harness)
- `Strategy` interface (`src/lib/backtest/strategy.ts`), wired into both engines (see Changed, below). `decideEntry(ctx, config)` runs only while flat with no pending order and returns an `EntryDecision` (side, market or limit order type, stop and target prices, optional time stop) or `null`; `decideExit(ctx, config)` runs only while in a position and returns whether to exit at this bar's close. `StrategyContext` carries everything a strategy can read at one bar: the candle index and series, the interpreted indicator suite, the composite score and tier, SuperTrend, the snapshot bar, HTF context, session, and the open position or pending order, all typed from the existing engine, trade-utils, limit-orders, sessions, and signal types rather than redefined
- `createScoreThresholdStrategy()` (`src/lib/backtest/strategies/score-threshold.ts`), today's inline engine rule re-expressed as the first `Strategy` implementation and the default both engines fall back to: enter long at `config.entryThreshold`, enter short at `config.shortEntryThreshold` when `config.allowShorts`, exit long at `config.exitThreshold`, exit short at `config.shortExitThreshold`, stop and target as fixed percent offsets from the entry bar's close
- Limit order fill primitives (`src/lib/backtest/limit-orders.ts`), wired into both engines. `evaluateLimitOrder(order, bar, candle)` fills a long (buy limit) on `candle.low < limitPrice` and a short (sell limit) on `candle.high > limitPrice`, both strict so an exact touch does not fill; a gap through the limit (the open already clears it) fills at the open instead of the limit price. An order never fills on its own placement bar and is cancelled the bar after `placedBar + timeoutBars` if still unfilled
- `computeExpectancy(trades)` on `src/lib/backtest/metrics.ts`, returning `expectancyPercent` (mean `pnlPercent` across trades) and `expectancyR` (mean `pnlPercent / riskPercent` over trades with a finite, positive `riskPercent`; `null` when none qualify). Both are now part of `BacktestMetrics`
- Funding accrual on open positions (`src/lib/backtest/funding.ts`). Perpetual futures pay or receive funding every 8 hours while a position is open, which swing and position trades hold across many times; `fundingCrossings(prevCloseTime, closeTime)` counts funding timestamps in a bar and `fundingPnl(notional, fundingRate, side, crossings)` applies the Binance convention (a positive rate means longs pay shorts). `BacktestConfig` gains `fundingEnabled` (absent or false keeps the legacy path bit-identical), `OpenPosition` gains accumulated `fundingPnl`, and `BacktestTrade` gains `fundingCost` (positive when the trade paid funding). Both engines accrue funding per bar through a shared `accrueFunding` helper in `src/lib/backtest/trade-utils.ts` so they cannot diverge, reading the point-in-time funding rate already carried by the snapshot series
- `RobustnessConfig` gains `minExpectancyPercent` (default 0): a candidate's `expectancyPercent` must exceed this floor, strictly positive net expectancy at the default. `minSharpe` alone no longer isolates a breakeven-or-worse candidate now that annualization makes Sharpe comparable across intervals (see Fixed, above), so this checks the number the study is actually judged on directly. Applied in `isRobust` (`src/lib/optimization/robustness-filter.ts`) alongside the existing criteria
- Maker and taker fees with slippage, modeled on Binance USDT-M futures (`src/lib/backtest/cost-model.ts`). `BacktestConfig` gains `makerFeePercent`, `takerFeePercent`, and `slippageBps`, all optional; `feePercent` remains the fallback for both when the specific rate is absent. `studyCostConfig(interval)` returns the standard-tier Binance rates (maker 0.02%, taker 0.05%) plus a per-interval slippage budget (`STUDY_SLIPPAGE_BPS`, 5bps on 1m/5m down to 2bps on 4h/1d). `take_profit` exits fill at a resting limit order (maker, no slippage); `stop_loss` and `signal` exits cross the book (taker, slip against the trader); `end_of_data` is a mark-to-model close (taker, no slippage). `closeTrade` in `src/lib/backtest/trade-utils.ts` applies this model and `BacktestTrade` gains `slippageCost` (both legs combined, see Fixed above), `entryFillKind`, and `exitFillKind`. With the new config fields absent, output is bit-identical to before this change
- `src/lib/backtest/bar-loop.ts`: the per-bar state machine now shared by `runBacktest` and `runOptimizedBacktest`, replacing the two engines' previously separate, hand-duplicated loops. Every bar it checks a position's stop and target, then a new `time_stop` exit (a position held `timeStopBars` bars closes at that bar's close), then a strategy's `decideExit`; if flat, it evaluates any pending limit order's fill or cancellation, then a strategy's `decideEntry`. `ExitReason` gains `time_stop`; `cost-model.ts` treats it as a taker fill subject to slippage, like `stop_loss` and `signal`. `BacktestConfig` gains `limitTimeoutBars` (default 3), used when an `EntryDecision`'s limit order omits its own `timeoutBars`. `openPosition()` in `trade-utils.ts` builds the resulting `OpenPosition` from any filled `EntryDecision` (market or limit), used by both fill paths in both engines
- Save gate for template creation (`src/lib/optimization/save-gate.ts`). `passesSaveGate(windows)` counts windows whose `oosMetrics` is not null (`contributingWindows`) and averages their `expectancyPercent` (`avgOosExpectancyPercent`, null when none contributed); it passes only when `contributingWindows >= SAVE_GATE.minContributingWindows` (2) and the average is positive, and otherwise returns a `reason` naming which condition failed with the numbers. The session 04 handover recommended this: the first two templates ever created were saved from a single contributing window with negative out-of-sample results, because only the top-five ensemble documents survive a walk-forward run and nothing checked how many windows actually produced an out-of-sample result first
- Random-entry benchmark (`src/lib/backtest/random-entry-benchmark.ts`), answering whether a strategy's entry timing beats random entries that share its exits (tests entry timing given the realized exit distribution, not the exit rule itself). `referenceProfile(result)` samples a reference `BacktestResult`'s trades into an `entryProbability` (trade count over the reference's flat-bar count, see Fixed above; clamped to (0, 1]), `longShare`, and parallel `holdBars`/`stopPercents`/`rewardPercents` arrays. `createRandomEntryStrategy(profile, seed)` returns a `Strategy`, deterministic per seed via a local mulberry32 PRNG (`src/lib/stats`'s seeded generator is not on this branch), that enters at market with the profile's probability and side mix and a stop/target/time-stop sampled from one profile index, and never exits by signal. `randomEntryBenchmark(prepared, config, symbol, interval, reference, opts)` runs `opts.iterations` such strategies (seeded `opts.seed + k`) through the same prepared data, config, costs, and funding as the reference, and returns `observedExpectancy`, `randomExpectancies`, `meanRandom`, `sdRandom`, and `pValue` (the share of random draws at or above the observed expectancy, with a pseudo-count of 1 so it is never exactly 0). `BacktestTrade` gains `rewardPercent` (target distance as a percent of the filled entry price, `null` when the position had no target), set by `closeTrade` alongside `riskPercent`
- Pure statistics module (`src/lib/stats/`) for the strategy validation gate: a seeded mulberry32 generator, a stationary block bootstrap with a percentile confidence interval and max-drawdown-percent helper, normal distribution helpers (CDF, quantile, sample skewness and kurtosis), the deflated Sharpe ratio (Bailey and Lopez de Prado), and a parameter plateau score. No engine or Mongo dependency; all Sharpe values are per period, not annualized

### Changed (evaluation harness)
- `runBacktest` and `runOptimizedBacktest` both take an optional final `strategy: Strategy` parameter, defaulting to `createScoreThresholdStrategy()`. Called with no strategy, both engines reproduce their pre-existing trades, equity curve, and metrics bit for bit (`golden-regression.test.ts` fixture unchanged; `engine-parity.test.ts` still holds). A position closed by a price/bar-based reason (`stop_loss`, `take_profit`, `time_stop`) frees its bar for a same-bar pending-order evaluation or fresh entry, exactly as the pre-Strategy engines allowed for `stop_loss`/`take_profit`; a position closed by the strategy's `decideExit` ('signal') does not get a same-bar re-entry, nor does a limit order that fills or is cancelled this bar
- `OpenPosition` gains `stopPrice`, `targetPrice`, and `timeStopBars`, set from the filled `EntryDecision`. `checkStopTakeProfit(position, candle)` reads these directly instead of deriving levels from `config.stopLossPercent`/`takeProfitPercent` (the `config` parameter is gone); a `null` `targetPrice` never triggers `take_profit`. `computePositionSize` takes the entry's absolute stop price as an explicit parameter instead of deriving it from `config.stopLossPercent`, so risk-based and fixed-fractional sizing follow the strategy's actual stop distance
- `closeTrade`'s `riskPercent` is now `|entryPrice - stopPrice| / entryPrice * 100` from the filled position, instead of `config.stopLossPercent * 100`; for the score-threshold strategy's market fills the two formulas agree up to floating-point rounding. `BacktestTrade.riskPercent` is required (`closeTrade` always sets it); `entryScore` and `entryTier` are optional instead, since a non-score strategy supplies neither, while the score-threshold strategy still fills both on every trade
- Auto-activation's minimum backtest-results floor (`src/lib/optimization/auto-activation.ts`) drops from 5 to 3 contributing windows, now that both save paths write the same `contributingWindows` count (see Fixed, above): `position_trading`'s purge gap left it unable to reach 5. Provisional pending re-measurement, alongside `minSharpe` (see the migration note below); `OPTIMIZATION_AUTO_ACTIVATE` keeps auto-activation disabled in production regardless
- `calculateWindows` takes an optional `opts` argument (`purgeGapBars`, `mode: 'anchored' | 'rolling'`, `rollingTrainBars`). A purge gap of untraded bars now sits between `trainEnd` and `testStart` (`testStart = trainEnd + 1 + purgeGapBars`), so a window is only produced when a full test slice still fits past the gap. `mode: 'rolling'` keeps a fixed training width (`rollingTrainBars`, default `minTrainingBars`) instead of the default anchored/expanding training set. `WalkForwardConfig` gains the matching `purgeGapBars`, `windowMode`, and `rollingTrainBars` fields; `runWalkForward` defaults `purgeGapBars` to the style/interval's own indicator warmup (the same `computeAllIndicators` + `computeWarmupBars` pair `prepareBacktest` uses) when the caller omits it, so training and test windows never share warmed-up indicator state across the boundary. The orchestrator and the admin optimize-template route pass no new options, so their windows shift by this default gap only: measured per style at a representative series length and `targetWindows: 6`, scalping and day/swing trading still land at 6 windows (were 7), position trading drops to 4 (was 6), because its 400-bar SMA leaves a ~399-bar warmup against a 420-bar minimum training window. No template is active in production, so nothing depends on the old window boundaries
- `WalkForwardWindow` (`src/types/optimization.ts`) gains `oosMetrics: BacktestMetrics | null` and `robustCandidates: number`; `bestWeights` and `testSharpe` are now optional, since a skipped window (no robust in-sample candidate) has neither. `runWalkForward` records every window, including skipped ones (`oosMetrics: null`, `robustCandidates: 0`, only the four boundary fields set), so how many windows were profitable out of sample is answerable after the run. `OptimizationJob` gains `windows: WalkForwardWindow[]` (`Schema.Types.Mixed`, default `[]`); the orchestrator and the admin optimize-template route store `result.windows` on the job after `runWalkForward`
- The orchestrator and the admin route call `passesSaveGate(result.windows)` before `createTemplateVersion`. On failure, no template is created: the orchestrator records the gate's `reason` on the `CronRun` job detail's new `gateReason` field (`ICronJobDetail`, default null) and skips auto-activation for that style; the route returns the gate result in its JSON (`templateVersion`/`templateId` null). Either way the job still completes, since a refused save is a valid outcome, not an error. The average that divides by `ensembleResults.length` in both places is now guarded against an empty ensemble (0 instead of `NaN`)

Migration note: `RobustnessConfig.minSharpe` (0.5) and auto-activation's contributing-window floor (3) are both provisional thresholds, set (or in `minSharpe`'s case, inherited) before this branch's fixes changed what they gate against -- `minSharpe` predates the annualization fix that made Sharpe comparable across intervals, and the window floor predates both `contributingWindows` becoming consistent between save paths and the purge gap that shrank how many windows a style like `position_trading` can contribute. Neither has been re-measured against the current pipeline; treat both as due for Phase 3 re-measurement rather than settled numbers. `OPTIMIZATION_AUTO_ACTIVATE` keeps auto-activation disabled in production in the meantime.

### Added (research toolkit)
- `scripts/research/export-dataset.ts`: exports Candle, HistoricalSnapshot, and derived HTF-confluence data to gzip newline-delimited JSON under `data/research/` (gitignored), one file per symbol, interval, and kind, plus a `manifest.json` listing every file's row count, timestamp range, and sha256, and a dataset-wide hash (sha256 over the sorted per-file hashes) so two exports of the same data always hash identically. Candles are read through a Mongoose cursor sorted ascending rather than `getCandles`, which caps at 50,000 rows. HTF context is computed once per symbol and interval with a 250-bar warmup before the requested start and aligned with `alignHtfToLtf` so each row's context comes from the newest higher-timeframe bar closed at or before that bar, keeping the HTF file's row count equal to the candle file's even when every context is null (no confirmation interval for 1d, or indicator warmup not yet satisfied)
- `scripts/research/load-dataset.ts`: loads exported candles, snapshots, and HTF rows and enforces a lockbox on data from 2026-07-01 onward, dropped by default and reported via `droppedRows`, kept only when a caller explicitly passes `allowLockbox`. `verifyManifest` recomputes every file's sha256 and the dataset hash so a single tampered byte is reported by path. Research subagents read this dataset instead of Mongo, so every agent works from one identical, hashed, held-out dataset
- `scripts/research/dataset-format.ts`: the shared, Mongo-free row and manifest shapes (`CandleRow`, `SnapshotRow`, `HtfRow`, `DatasetManifest`) plus the gzip newline-delimited JSON read/write and sha256 helpers both scripts above build on
- `scripts/{ops,research}/**/*.{test,spec}.ts` added to Vitest's test include, alongside the existing `src/**` pattern, so script-level unit and mongodb-memory-server integration tests run under `npm run test`
- `scripts/research/ic-stats.ts`: pure information-coefficient statistics for the factor study -- rank with average-rank ties, Spearman correlation, forward returns, Newey-West (HAC) mean/se/t-stat, `icWithHac` (every overlapping bar, HAC-corrected t at lag h-1) and `icNonOverlapping` (every h-th bar, naive t), sign hit rate, quantile spread, a stationary block bootstrap and percentile confidence interval, and per-quarter rolling IC. `standardizedRankProducts` (the per-pair terms `icWithHac` already averages to get `ic`) and `bootstrapCiOfMean` (percentile bootstrap CI for a series' mean, same block/seed semantics as `bootstrapCi`) together give a fixed-rank block bootstrap of a Spearman IC: ranks computed once, not re-ranked inside every resample, so each iteration is O(n) instead of the O(m log m) sort `bootstrapCi` pays every time -- `factor-ic.ts`'s CLI uses this pair, not `bootstrapCi`, which stays exported and covered by its own tests for any other caller
- `scripts/research/factors.ts`: `computeFactorMatrix` builds a causal, per-bar factor matrix from exported dataset rows using the same code paths live scoring uses -- `prepareBacktest`'s indicator suites and SuperTrend, `computeSignalScore` with the interval's style and `DEFAULT_TEMPLATE_WEIGHTS`, and the HTF context C1 already exported per bar. One factor per fired `IndicatorSignal` (`sig.*`), one per scorer category (`cat.*`), the composite score, and twelve raw factors (RSI, EMA spread, ATR%, funding rate, long/short ratio, taker buy ratio, Fear & Greed, HTF trend, 1/5/20-bar returns, 20-bar realized vol). Every value is NaN before indicator warmup or when its own input is missing at that bar, never defaulted to zero
- `scripts/research/report-schema.ts`: Zod schemas for `FactorIcReport` and `SubagentReport`, validated with `validateFactorIcReport`/`validateSubagentReport` (`{ ok: true, data }` or `{ ok: false, issues }`, built from `ZodError.issues`). `SURVIVOR_RULE` (`minAbsIc` 0.02, `minT` 2.5, `minHorizons` 2, `minQuarterAgreement` 0.6, `minSymbolAgreement` 0.7) and `evaluateSurvivors` apply one fixed rule to every factor: a horizon passes on the pooled `|ic|`/`|icT|`, then quarter and symbol agreement (both measured only at the horizons that passed, against the sign of the strongest-`|icT|` passing horizon) test whether that effect holds over time and across symbols rather than surviving on one quarter or one symbol. `checkFindings` grounds a subagent's headline claims against the study's own tables (any numeric field of the matching `HorizonStat`s or rolling-quarterly entries other than `horizon`/`n`, an index and a sample size rather than a statistic, pooled plus rolling when no symbol is named, the named symbol's table otherwise), and `spotCheckCell` compares a freshly recomputed (ic, n) against the report's value for the orchestrator's re-run spot checks. `FactorIcReport.bootstrap` also carries `gateAbsT`/`maxPairs`, and `FactorIcReport` gains `skippedFactors` (name, category, reason), both described below
- `scripts/research/factor-ic.ts`: the factor IC study CLI four research subagents run, one per interval. Verifies the dataset manifest, loads every requested symbol through C1's lockbox-aware loaders (snapshots forced null on 5m/15m, which never have a snapshot file), builds each symbol's causal factor matrix, and for every requested factor measures `icWithHac`/`icNonOverlapping`/`signHitRate`/`quantileSpread` per symbol and pooled (concatenated in symbol order), plus pooled rolling-quarterly IC. A factor/horizon with fewer than 3 usable pairs anywhere (e.g. a funding-rate-derived factor on 5m/15m, which is NaN for every bar) is omitted rather than written as NaN, since `FactorIcReport`'s numeric fields are plain, schema-validated numbers; a factor with no usable horizon at all is recorded in `skippedFactors` (with a reason) instead of silently disappearing from the report. Pooled `bootstrapCi95` is only computed for a (factor, horizon) cell whose pooled HAC `|icT|` is at least `gateAbsT` (2); other cells carry `bootstrapCi95: null`. A pooled series larger than `maxPairs` (default 100,000, `--bootstrap-max-pairs`) is deterministically reduced before bootstrapping: split into 20 equal strata, one seeded-random contiguous block kept per stratum and concatenated in order, so a multi-symbol pooled series stays represented across every symbol while each kept block's internal autocorrelation structure is unbroken. The bootstrap itself is a fixed-rank block bootstrap (`ic-stats.ts`'s `standardizedRankProducts`/`bootstrapCiOfMean`, not `bootstrapCi`): ranks computed once per (sub)sample rather than re-ranked per resample, an approximation standard at this sample size, without which the unconditional "always on" pooled bootstrap measured at roughly 15 minutes per cell at production scale, and even the gated, subsampled, re-ranking version still measured about 21 seconds per gated cell; the fixed-rank version measures about 0.3 seconds per gated cell at the same 100,000-pair, 200-iteration bound. Default `--bootstrap-n` is 200 (was 1000). Per-symbol `bootstrapCi95` (`--bootstrap-per-symbol`, off by default) uses the same fixed-rank method, ungated. Validates against `FactorIcReportSchema` before writing, prints the top 15 pooled `|icT|` (factor, horizon) rows across all horizons, the survivor count, and the skipped-factor count to stdout, progress to stderr. `--cell factor:horizon[:symbol]` recomputes and prints one cell's (ic, n) with no file written, for the orchestrator's spot checks
- `scripts/research/strategy-families.ts`: a registry of parameterized strategy families for the walk-forward harness. `ParamSpec`/`StrategyFamily` declare a numeric parameter grid (booleans as 0/1) and a `create(params, ctx)` that turns one grid cell into a `Strategy`; `expandGrid` materializes the cartesian product in declared order (first param slowest), bounded by `MAX_PARAMS` (4) and `MAX_GRID_CELLS` (60), `[{}]` for a family with no params. `STRATEGY_FAMILIES.control` wraps `createScoreThresholdStrategy()` with no params of its own, since its thresholds and weights come from the walk-forward's config, not the family. `factors.ts`'s `toOHLCV`/`toLeanSnapshot` are now exported for the walk-forward harness's own callers to reuse
- `scripts/research/strategy-walk-forward.ts`: a pure, Mongo-free walk-forward that runs a strategy family's parameter grid through `prepareBacktest`/`runOptimizedBacktest`. `resolveWindowConfig` derives train width, purge gap, and test width from a candle series and a style (the same `computeMinCandles`/`computeWarmupBars` derivation `runWalkForward` uses), producing contiguous, non-overlapping out-of-sample segments via `calculateWindows` (normally the requested count; the resolved count is reported). `runStrategyWalkForward` selects, per window, the grid cell with the highest in-sample expectancy among cells at or above `minIsTrades` trades (earliest index breaks a tie; a window where every cell falls short is skipped with a reason, though every cell's out-of-sample summary is still recorded), then runs the selected cell out of sample, at stress-multiplied costs, and through `randomEntryBenchmark` (seeded `benchmark.seed + 100000 * (window index + 1)`, skipped when the selected cell had zero out-of-sample trades)
- `scripts/research/strategy-gates.ts`: pooled statistics and the eight fixed validation gates (`sample`, `expectancy`, `windows`, `symbols`, `timing`, `trials`, `plateau`, `stress`) a strategy family must clear across the study symbols, pure and no I/O. `poolStrategyResults` pools every selected out-of-sample trade across symbol and window (sorted by exit time) into `n`, `expectancyPercent`/`expectancyR`/`winRate`/`profitFactor`/`medianHoldBars`/`maxDrawdownPercent`, a stationary block-bootstrap `bootstrapCi95` (`meanBlockLen = max(2, round(cbrt(n)))`), window/symbol positive shares (a skipped window or a symbol with no positive-mean pooled trades counts as not positive), a trade-weighted pooled random-entry-benchmark p-value, a deflated Sharpe probability (per-cell Sharpes pooled across symbol and window for `varianceOfTrialSharpes`, `psrRadicand`/`probabilisticSharpe` from `src/lib/stats/deflated-sharpe.ts`), a parameter plateau score computed in index space (a neighbor is a cell at most one value-index step away in every dimension, so grids whose dimensions have different cardinalities are handled; null for a single-cell grid), pooled stress-run expectancy, and a per-year breakdown. Every ratio that can come out NaN or Infinity (zero trades, a zero denominator, a degenerate bootstrap or plateau) is stored as `null`. `evaluateStrategyGates` checks the fixed `VALIDATION_PROTOCOL` thresholds (100 out-of-sample trades, 300 for 5m; 0.6 window and 0.7 symbol positive share; random-entry p below 0.05; deflated Sharpe probability at or above 0.95; plateau score at or above 0.6, or not applicable for one cell; positive stressed expectancy) in a fixed order and returns a failure note for each null case
- `scripts/research/report-schema.ts`: adds `StrategyReportSchema`/`StrategyReport` (Zod v4, `pooled`/`gates` mirroring `strategy-gates.ts`'s `PooledStats`/`Gate` field for field) and `validateStrategyReport`. `checkStrategyFindings` grounds a strategy subagent's headline claims: a finding with no symbol against every finite number reachable inside `pooled` (excluding raw counts, indexes, and `perYear[].year`/`trades`) plus every gate's `value`; a finding naming a symbol against that symbol's pooled out-of-sample expectancy/win rate; a finding naming a symbol and window against that window's out-of-sample numbers and its benchmark p-value. `spotCheckStrategyWindow` compares a freshly recomputed (trades, expectancyPercent) against the report's own window, tolerant of float drift, both-null counting as a match, a missing or skipped window returning `ok: false`. `SubagentReportSchema`'s `topFindings` entries gain an optional `window` index
- `scripts/research/strategy-harness.ts`: the strategy validation harness CLI research agents run, one per (family, interval). Verifies the dataset manifest, loads every requested symbol's candles/snapshots/HTF confirmation candles (5m and 15m read the symbol's 1h snapshots via `mapToSnapshotInterval`, matching live scoring; HTF candles are filtered only to `t <= end`, so bars before `--start` stay available as warmup), and aborts on mixed snapshot coverage across symbols (naming the symbols missing rows) rather than silently running funding on for some and off for others. Runs C4a's `runStrategyWalkForward` per symbol with `minIsTrades: 10` and the requested stress/benchmark/window settings, pools the result through `strategy-gates.ts`, assembles and validates a `StrategyReport`, and writes it to `--out`. `--cell SYMBOL:WINDOW --report <file>` recomputes one window from a previously written report (family, interval, window geometry, costs, funding, stress, and lockbox setting all taken from the report, not the CLI's own flags) and prints `{ symbol, window, trades, expectancyPercent }`, aborting if the report's own window geometry cannot be reproduced or the window was recorded as skipped. `parseArgs`/`runStrategyHarness`/`runCell` and the `--cell`/`--report`/`resolveCommit`/`require.main` conventions mirror `factor-ic.ts`
- `scripts/research/strategy-families.ts` gains four Phase 4 strategy families built from the Phase 3 factor study's survivors: `fade-composite` (trade against the composite score at T/timeStop/k, 18 cells), `return-reversal` (fade an L-bar z-scored return against its own 20-bar realized vol, L/Z/H, 27 cells), `oscillator-reversion` (buy oversold/sell overbought RSI, optionally band-gated by Bollinger, R/H/band, 18 cells), and `stochrsi-momentum` (follow a StochRSI cross out of its zone, zone/hold/k, 18 cells)
- `scripts/research/strategy-families.ts` gains `withLimitEntry(base, name, params, opts)`, converting a base strategy's market entry into a resting limit order (`timeoutBars`/`offsetBps` from the decision close) while leaving its exit rule and the base decision's stop, target, and time stop untouched, plus three limit-entry variants of the Phase 4 families whose entry timing beat random entries intraday: `control-limit` (wraps `createScoreThresholdStrategy()`, timeout/offsetBps, 9 cells), `return-reversal-limit` (wraps `return-reversal`, L/Z/H/timeout, offset fixed at 0, 16 cells), and `oscillator-reversion-limit` (wraps `oscillator-reversion`, R/H/band/timeout, offset fixed at 0, 16 cells), testing whether that timing edge survives paying the maker rate instead of the taker rate
- `control-limit`'s `offsetBps` grid widened from [0, 5, 10] to [0, 5, 10, 20, 30] (15 cells, was 9), since every 5m and 1h window selected offsetBps 10, the deepest pullback in the prior grid, so the grid edge was binding

### Fixed (research toolkit whole-branch review)
- `export-dataset.ts` computed every interval's HTF context with `computeHtfSeries`'s default config, which equals `day_trading`'s EMA/SMA periods -- silently wrong for every other style (5m/scalping's 5/13 EMA and 20/50 SMA, 4h/swing's 21/55 EMA, in particular), corrupting `sig.HTF*`, `cat.htf`, `raw.htfTrend`, and `composite` in the exported dataset itself, not just at read time. `buildHtfRows` now takes the LTF interval's own style config (`getStyleConfig(styleForInterval(interval)).config`, the same style resolution `factors.ts` uses, now exported from there), matching live scoring's `computeHtfSeries(closed, profile.config)`. HTF warmup candles are now fetched by bar count (`fetchCandlesBefore`, at least the style's longest lookback -- `max(ema.slow, sma.long)` -- plus a 50-bar margin) rather than by subtracting a fixed duration from the export start, so gaps in the underlying data cannot starve the warmup below what the indicators need
- `factors.ts`'s `computeFactorMatrix` fires an Ichimoku signal for scalping, unlike live scoring (`computeIndicatorsForStyle` nulls Ichimoku for scalping before interpretation; `prepareBacktest`/`interpretIndicatorsAtBar`, the shared backtest indicator path this file also uses, has no such style awareness -- a pre-existing divergence any backtest/harness branch built on `optimized-engine.ts` inherits too, noted in this file's header as a caveat). `computeFactorMatrix` now strips Ichimoku's raw reading and derived trend signal from the suite it hands to the scorer when style is scalping, so `sig.Ichimoku` is absent at 5m as it is live. Also: bars before `warmupBars` are no longer scored at all (nothing downstream ever read that work); `htf` is now required to be index-aligned with `candles` (same row count, same timestamps per row), checked and thrown on rather than trusted, since a silent misalignment would attribute the wrong HTF context to a bar with no error
- `factor-ic.ts`'s forward-return cache stored `(number | null)[]` per (symbol, horizon), which forces V8 into boxed/tagged array elements once `null` appears (measured 144.2 MB at 10 symbols x 6 horizons x 105,000 bars); it now caches `Float64Array` (NaN as the missing sentinel, measured ~48.1 MB and entirely off the V8 heap, in ArrayBuffer/external memory). `--horizons` rejects non-positive or non-integer values (a non-positive horizon previously reached `nonOverlappingIndices`, now guarded there too, and looped forever); an unrecognized `--flag` is now rejected instead of silently absorbing its value as a no-op. The CLI's loader path (`loadSymbolData`) now checks candle/HTF alignment independently of `computeFactorMatrix`'s own check (belt and suspenders across the two layers)
- Nothing pinned which dataset a `FactorIcReport` or `SubagentReport` was built from. `factor-ic.ts` gained `--expect-manifest-hash` (abort when the loaded dataset's manifest hash differs, checked in both the full-report and `--cell` paths) and `report-schema.ts` gained `checkReportConsistency(sub, factorReport)` (fails when `datasetManifestHash` or `lockboxApplied` differ between a subagent's report and the factor report it cites). `--cell` also gained `--report <path>`: reads `symbols`, `dateRange` (as start/end), and `lockboxApplied` (as `!allowLockbox`) from that `FactorIcReport` and uses them unconditionally, so the orchestrator's spot check reproduces exactly the window a subagent's report was built from rather than whatever the CLI invocation's own flags said; the current dataset's manifest hash is also checked against the report's own in this mode
- `checkFindings` (`report-schema.ts`) no longer grounds a finding's value against a `HorizonStat`/rolling entry's `horizon` or `n` fields -- an index and a sample size, not a statistic a finding should be able to "cite" by coincidence
- `factors.test.ts` now hand-computes `raw.emaSpreadPct` and `raw.realizedVol20` (alongside the existing `raw.ret1` hand computation) from an independently prepared suite/raw closes. `dataset-format.ts`'s `readJsonlGz` gained a doc warning that it bypasses the lockbox (use `load-dataset.ts`'s loaders instead), and a test confirms two writes of the same rows produce byte-identical gzip files (Node's default gzip mtime is already 0, so this was already true; the test locks it in)

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
