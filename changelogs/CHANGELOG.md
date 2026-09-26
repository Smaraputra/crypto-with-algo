# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (research): named fee profiles and the composite sign audit
- **Named fee profiles** `standard`, `bnb` and `promo-btc-eth-2026-07` in the research cost model, with `--fee-profile` threaded through `strategy-harness.ts`, `exposure-harness.ts` and `frontier.ts`
- **Per-symbol costs are now recorded in reports**, and `costsForSymbolReport` is spot-checked for parity against the CLI's own per-symbol pricing
- **`scripts/research/composite-audit.ts`**, which restates a factor-ic report in the live composite's own terms: per-signal and per-category IC against the live sign, an additive ceiling, and the taker/maker breakeven under each fee profile

### Changed (research): frontier per fee profile with the hold-profile caveat and leverage arithmetic
- **`frontier.ts` prices its targets, its profile comparison and its leverage block under `--fee-profile`**, and its header now carries a caveat that a breakeven computed from a multi-bar hold's sd does not apply to a factor scored over a single bar, plus the leverage arithmetic (cost as percent of account scales with leverage, liquidation distance does not)

### Audit findings, 2026-09-26
- **The frontier header's "5x the maker breakeven" reading for `raw.btcLeadLag` was superseded**: it compared the factor's 0.0219 IC at h1 against a breakeven derived from the control family's 4.56% multi-bar hold sd rather than the single-bar sd the factor is actually scored over, so the true breakeven is about 0.025 to 0.037 and 0.0219 falls short of it rather than clearing it 5x
- **The composite sign audit headline per interval**: 5m composite ic -0.0151, ceiling 0.015802, cheapest taker be 0.1103 (ceiling far below); 15m composite ic -0.0344, ceiling 0.018879, cheapest taker be 0.0323 (ceiling below); 1h composite ic -0.0086, ceiling 0.009404, cheapest taker be 0.0145 (ceiling below); 4h composite ic +0.0374, ceiling 0.024960, cheapest taker be 0.0061 (ceiling above, unprovable at this sample size); 1d composite ic +0.0110 (insignificant, t 0.53), ceiling 0.048550, cheapest taker be 0.0035 (ceiling above, htf category missing)
- **The pre-registered promo fee check (BTCUSDT and ETHUSDT, `--fee-profile promo-btc-eth-2026-07`) failed expectancy at both 15m and 1h for both `control` and `control-limit`** (control-limit 1h -0.0412%, CI spanning zero); the kill criterion fires, closing the fee question for the composite under any profile, with the caveat that no matching standard-profile run on the same two symbols was pre-registered
- **The monthly optimizer defects (empty-candidate ensemble failures, the win-rate robustness gate) are already recorded under Fixed (optimization) below**
- **The v7 rollout watch's directional tier rate (6.9% scalping, 3.5% day trading against a 10% design) and live p90 (26.5 at 1h against a calibrated 32.2) sit inside the recorded daily spread (11.3 to 42.8)**: judged against the daily p90 spread, not a defect, and the watch is to be removed
- **Standard VIP 0 fees (0.02% maker / 0.05% taker) are verified against the cost model, BNB gives 10% off, and the 2026-07-02 promotion's 0 maker / 20% taker discount is on contracts a Binance Square repost names "BTCU and ETHU"**, but whether that is BTCUSDT/ETHUSDT was not verified from a primary source, so the user's own account fee page is the check; leverage multiplies notional so fees and edge scale together (a 0.072% taker round trip at 10x on 100 USDT is 0.72% of the account), and liquidation distance is about 1/L minus maintenance margin (about 4.6% at 20x, 1.5 to 1.6% at 50x)
- **The user's own February 2026 Binance USDT-M trade history (309 fills, 2026-02-15 to 2026-02-26) confirms the standard 0.02%/0.05% schedule with no BNB discount**, and was gross break-even before fees (-3.06 USDT on 945,211 USDT notional) with the realized loss essentially equal to fees paid (380.75 USDT, net -383.81)

### Fixed (optimization): no-candidate runs complete instead of failing
- **The monthly optimizer recorded "no robust candidate in any window" as a failed job** (`Cannot create ensemble from empty results`, seen on the 2026-09-16 and 2026-09-17 runs); it now completes with the save gate's reason
- **The robustness filter no longer rejects or ranks candidates on win rate**: `minWinRate` is removed from `RobustnessConfig`, and `getRobustnessScore`, whose only callers were its own tests, is removed

### Measured (research): Phase A and Phase B, 2026-09-26
- **The Phase A 15m control run (task pA)** measured n 4796, expectancy -0.1175%, CI95 [-0.1740, -0.0583], win rate 0.321, payoff 1.64, profit factor 0.769, median hold 7 bars, 24.02 trades a day, random-entry p 0.244. It fails on expectancy, windows, symbols, timing, trials and stress, as every control has, and its row now sits in the `frontier.ts` table: n 4796, 24.02 trades/day, sd 2.04%, breakeven IC 0.0391 taker and 0.0098 maker
- **Phase B measured 15m, 1h and 4h in one pass on both axes**, dataset `e84cd66dbe01`, lockbox applied, lag 1, ten symbols, then a leave-one-out control pass at 1h and 15m. On the time-series axis, no new column survives at any interval. `raw.btcLeadLag` is the strongest fine-interval reading the program has recorded (h1 +0.0219 t+12.5 at 1h, 5x the 1h maker breakeven, monotone decay to h8), but it fails the rule twice: h2 is 0.0187 against the 0.02 floor, and quarter agreement at h1 is 0.63. It is recorded as a near miss, not a survivor
- **The leave-one-out control `raw.btcLeadLagLoo` bounds the own-return contamination at 0.0011 to 0.0014** (h1 +0.0205 t11.8, h2 +0.0176), far under the predicted bound of about 0.006, so the reading is not the reversal in disguise. `raw.sessionDrift` and `raw.hourOfDayDrift` survive with the wrong sign at 15m and 1h, both a correlated variant of the slow reversal `raw.ret20` already carries rather than a new finding
- **Taker-intensity conditioning holds at 15m** (60% and 124% over the pre-registered third-of-unconditional-|ic| floor at h2 and h8) and fails at 1h and 4h (19% and 0%). The 15m conditioned reversal still sits below the 15m taker breakeven, so it stays a diagnostic, never a family
- **The cross-sectional axis does not fire the kill criterion.** Survivors: 12/60 at 15m, 14/60 at 1h, 9/58 at 4h, led by `raw.realizedVol20` (1h h32 -0.0745 t-8.2, 4h h32 -0.0788 t-5.8, quarters 0.91 to 0.96, symbols 1.00 at both), with relative funding, positioning and depth imbalance also surviving at 1h and 4h above the two-leg maker floor of about 0.017 at 1h
- **Verdict under the pre-registered kill criterion.** The time-series axis fires: no new column survives above its interval's maker floor. The cross-sectional axis does not: several existing inputs survive at 1h and 4h above the two-leg floor. Phases C and D (the 1m and aggTrades ingests) were aimed at fine-interval time-series content and are not motivated by this result. A cross-sectional container at 1h and 4h is the open decision, left to the user
- **Dataset note and task-id relabel.** The 15m cross-section has 26,766 bars with five or more symbols (about 279 days) against 41,098 at 1h (4.7 years) and 16,598 at 4h, so 15m evidence is the thinnest and its quarter agreement spans about four quarters. The eight reports were written with one task id per mode, and the phase table was built from copies relabelled `pB-<mode>-<interval>` because `evaluatePhaseSurvivors` refuses duplicate ids

### Fixed (research): the cross-sectional pooled statistic was not cross-sectional
- **At 4h `raw.fearGreed` is identical across symbols at every bar**, so its per-bar series is empty, yet the pair-pooled statistic still scored it at ic -0.028 with t -10.3 across six horizons, and 27 of 63 factors "survived" against 8 in time-series mode
- **The pooled block in cross-sectional mode is now the per-bar Fama-MacBeth statistic** (mean bar IC, Newey-West t over the bar series), bar-constant inputs are skipped with a reason, and `MIN_CS_BARS` is set to 30. The three cross-sectional reports were re-run on the fixed build (`crypto-ops:phaseb2`, commit `b4851ad`). Survivors per report after the fix: 15m 12/60, 1h 14/60, 4h 9/58, and the phase-wide FDR over 2,361 cells rejected 1,371 and moved no count

### Added (research): `raw.btcLeadLagLoo`
- **The pre-registered leave-one-out control**: BTC's ret1 minus the equal-weight mean over the other alts, with the read symbol and BTC both excluded, NaN for BTC and below five symbols
- **Bounds the contamination from the read symbol's own return entering the market mean.** Measured at 0.0011 to 0.0014 (h1 +0.0205 t11.8, h2 +0.0176), far under the predicted bound of about 0.006

### Added (research): Phase B columns
- **`raw.hourOfDayDrift`, `raw.sessionDrift`, `raw.depthNotionalZ`, `raw.ret1InHighTaker`, `raw.ret1InLowTaker` and `raw.btcLeadLag`**, each with a pre-registered sign, plus `seasonalDriftSeries` and `cross-symbol-factors.ts`

### Added (research): cross-sectional mode and perp return series for factor-ic
- **`--cross-sectional-demean`, `--min-cross-section` and `--return-series`**, plus `FactorMatrix.perpCloses` and `runCell` loading every symbol. Reports are byte-identical without the new flags

### Added (research): `frontier.ts`
- **The frequency-frontier tool and the 100 USDT arithmetic** it is built on, with the three pooled schema fields relaxed to optional so pre-2026-09-19 reports still validate

### Added (research): trades per day, reported only
- **`oosSymbolDays`, `tradesPerSymbolDay` and `tradesPerDay`** added to `PooledStats`, reported only and never gated

### Changed (research): the survivor rule is in code at |t| 3.15 with a phase-wide FDR
- **`benjaminiHochberg`, `pValueFromT` and `evaluatePhaseSurvivors`** in `survivor-table.ts`, with duplicate task ids refused and a near-miss section. The recorded p3b lag-1 counts reproduce: 22, 20, 15, 7, 4

### Added (signals): a calibration dashboard, so the live record can be read against what the market did
- **New admin page `/admin/calibration`** over the resolved `SignalOutcome` record, reading it four ways: net expectancy per tier with confidence intervals, a reliability curve, the forward-return distribution per tier, and a cumulative net-return path split by `configVersion`. Read-only by construction -- the outcome resolver stays the only writer of `SignalOutcome`, which matters because that collection is the evidence base the `configVersion` record is read from
- **`getLiveTierExpectancy` had exactly one reader before this**, `scripts/ops/live-outcomes.ts`, which runs in the seeder image against production. The same numbers now have a screen, and the same three things that must never be pooled are enforced at the type level rather than by remembering: interval (a scalping 1m row is a 12-minute return and a 5m row a 60-minute one), source (composite and the LLM panel are different predictors), and `configVersion` (each version is a different scorer). The route rejects an interval the style does not score
- **Confidence intervals come from a block bootstrap whose block length is the horizon, never `cbrt(n)`.** Outcomes are written every bar over an h-bar horizon, so consecutive rows share h-1 bars of price history. The `max(2, round(cbrt(n)))` convention is calibrated on independent trades and is badly undersized on bar-frequency data, which is precisely how an interval too narrow to be true gets manufactured
- **New `groupedBlockBootstrapCi` in `src/lib/stats/`** resamples whole timestamp buckets rather than a flat series. Ten symbols at one bar move together, so flattening them treats the cross-section as ten independent draws and shrinks the interval by roughly sqrt(10). A test holds the property directly: the same 800 observations stacked ten-per-timestamp must yield a WIDER interval than spread one-per-timestamp
- **Nothing is estimated below 30 observations and no interval is drawn below 8 independent blocks**, with the reason shown in words rather than a blank cell. On a record that only begins at the 2026-09-17 finalization deploy, "no edge visible" and "barely any data yet" are the two readings that must not be confused, so resolved count, pending count and covered window sit above the charts, and pooling more than one `configVersion` raises a warning
- **The cumulative path defaults to non-overlapping and is labelled as not an equity curve.** Summing every signal adds up to `horizonBars` positions open at once on one symbol -- a path no account could take, and one that scales a small mean by h. The overlapping variant exists so the difference can be seen and is never the default
- **Fixed seed**, because an interval that moves on page refresh reads as instability in the signal rather than as resampling noise
- **Two extractions, so there is one definition each**: `defaultCostPercent` moved from `scripts/ops/live-outcomes.ts` into `src/lib/backtest/cost-model.ts` where its inputs already live (the app cannot import from `scripts/`, and a second copy is how the CLI report and the dashboard come to disagree about what "net" means); the sell-tier inversion became the exported `directionalReturn`, shared by the row-level analytics and the existing `$group` pipeline

### Fixed (ui): the signal tier palette was not distinguishable, by measurement
- **`--signal-sell` and `--signal-strong-sell` measured ΔE 8.2 at normal vision and 3.9 under tritanopia** against the dark surface -- below the 15 floor, so a full-colour reader could not reliably tell them apart either. Re-stepped the five `--signal-*` tokens, keeping the same hues; every adjacent pair now clears the colour-vision floor. Slightly alters `FuturesPanel` and the signal gauge, which are the other consumers
- **The applicable bar is 4.5:1, not 3:1, because these tokens are also text.** `FuturesPanel` applies them as `color` on the funding-rate and long/short values, `SignalGauge` on the tier label. A first re-step separated the pairs by darkening and pushed `--signal-buy` from 4.85 to **3.10** against `--card`, trading a colour-vision defect for a contrast regression. The shipped steps separate by going lighter instead: all five sit at 4.79 to 11.67, where `--signal-sell` previously failed at 4.43
- **Added an ordered `--config-version-*` ramp** for `configVersion` series: one hue at three lightness steps, since versions are ordered rather than categorical, with each line direct-labelled so identity never rests on colour alone


### Fixed (signals): calibration review findings
- **The non-overlapping sampler discarded valid signals.** `cumulativeReturn` inferred the bar length from gaps between rows, but the rows are filtered to actionable tiers first and most bars are neutral, so the smallest surviving gap was usually several bars. The inferred bar was that factor too large and the sampler over-thinned by it: ten signals four bars apart at a two-bar horizon, none of which overlap, yielded five. The bar length is now a required input supplied from the interval, and a test pins the ten-signal case
- **`loadCalibrationRows` no longer sorts in the database.** Nothing indexed `interval`, so the match fell back to the `tradingStyle+status` prefix and `.sort({ candleTimestamp: 1 })` became a blocking in-memory sort. Scalping writes about 14k rows a day at 1m across ten symbols, so the sorted set would cross Mongo's 32 MB limit within weeks of the record's 2026-09-17 start and the route would return 500. Every consumer already orders what it needs, so the sort only added a failure mode. Added the covering index `{ tradingStyle, interval, status, candleTimestamp }`
- **The cumulative path is decimated to 2,000 points per series.** With `overlapping` on at 1m the response carried a six-figure point count, past what a line chart can draw and past the cache's size ceiling, so every request recomputed it. Points are a running total, so keeping every nth preserves shape and endpoint exactly; the reported `count` stays the true total
- **A `configVersion` filter no longer survives a style or interval change.** A version in one style's record need not exist in another's, so the stale filter returned zero rows while the select -- which only lists versions the record holds -- rendered blank: an empty view with a control that did not admit it was filtering
- **The thin-record note now tests the current view rather than the whole record.** Coverage is deliberately unfiltered, so a five-row symbol slice of a five-thousand-row record withheld every estimate while the note explaining why stayed hidden
- **Moved the dashboard page test next to the page** it imports, per the tests-alongside-source convention; it was filed under the API route directory

### Measured (signals): the futures category is structurally bearish, and the cause is a miscentred band on a drifting input
- **Investigated because `cat.futures` averages -49.1 across both styles and every symbol**, pinned near half-scale bearish while `trend` averages +46.2 and `htf` +36.7. Behaviour is unchanged by this entry; the measurement is pinned in `scorer.ts` at the defect site so it cannot be lost
- **Funding is not the problem.** 9.5% of bars read bearish, 8.9% bullish, 81.6% neutral. Symmetric, and the neutral band deliberately swallowing Binance's 0.0001 base rate (33.1% of observations sit exactly on it) works as documented
- **The Long/Short Ratio signal is.** The bands assume the ratio is centred on 1.0; the field holds the TOP TRADER POSITION ratio, whose pooled median over 436,552 stored snapshots is **1.513** and mean 1.718, with per-symbol medians from 1.18 (BNB) to 2.22 (DOGE). Against the 1.3 trigger that makes **65.1% of bars bearish and 0.4% bullish**, a 163:1 asymmetry. The 0.77 bullish trigger sits below the 5th percentile of every symbol -- the lowest ratio ever observed for any of them is 0.68 -- so the bullish branch is close to dead code, and 26.3% of bars land above 2.0, a branch written to mark an extreme
- **The centre drifts by more than the band is wide, so no fixed threshold can be correct.** Share of bars called bearish, by quarter:

| quarter | BTC | ETH | DOGE | BNB |
| --- | ---: | ---: | ---: | ---: |
| 2023Q1 | 3% | 22% | 87% | 0% |
| 2024Q1 | 76% | 100% | 100% | 64% |
| 2025Q3 | 100% | 100% | 100% | 16% |
| 2026Q2 | 10% | 47% | 100% | 47% |
| 2026Q3 | 94% | 86% | 100% | 100% |

- **ETH read bearish on 100% of bars for eight consecutive quarters**, 2024Q1 through 2025Q4. A signal that never changes direction carries no information: over those stretches it contributed a constant offset to every composite and nothing else
- **What it costs**: a standing bearish contribution of -2.1 points of composite for scalping, -4.2 for day_trading, -8.8 for swing_trading and **-12.3 for position_trading**, where futures carries 0.25 of the weight. It also makes the composite's shape symbol-dependent, which is the same objection the v6 scale work raised: one cutoff pair can only mean one thing if the distribution beneath it is the same shape everywhere
- **The fix shape is already validated on the research side**: a within-symbol trailing z, which is what Phase 3b used when the raw level failed quarter agreement. Measured on the same snapshots with a 30-day window, `|z| > 1` gives 27.0% bearish and 22.1% bullish pooled, staying inside 24.6-29.0% and 19.4-23.8% for every symbol
- **Deliberately not fixed in this change.** It alters live scoring, so it means configVersion 8 and another break in the live record one day after v7. The research record also says positioning is "a robust factor, not an edge" -- both rule shapes failed the gates -- so the fix buys honesty and cross-symbol comparability, not profit


### Added (research): `daily-p90.ts`, because a pooled multi-year percentile is not a baseline for one day
- **Written after making exactly that mistake.** A live `|score|` p90 of 23.9 at 1h read as an 8-point shortfall against the calibrated 32.2, which looked like a systematic difference between live scoring and the exported research path. It was an ordinary soft day
- **The missing denominator is the spread of days.** Measured across the full export: at 1h, daily p90 spans **11.3 to 42.8 over 1800 days** with an interquartile range of 27.5 to 33.7 and a median of 30.7; at 15m, 11.8 to 41.8 over 920 days, median 29.0. A single day sits six points either side of the pooled figure for no reason beyond the market. Live 23.9 sits at the **8.4th percentile of days** at 1h and 26.2 at the **31.8th** at 15m
- **The research path scoring the same hours agrees**: 24.4 at 1h and 24.5 at 15m for 2026-09-25, against live's 23.9 and 26.2
- **At bar level the two paths are identical.** On every bar BTCUSDT 1h shares between the export and the live record, the composite and all seven category scores match to zero difference. There is no live-versus-export divergence
- **Ruled out on the way, each worth not re-testing**: live weights are not a suspect (both `signaltemplates` rows are `active: false` and `factors.ts` uses the same `DEFAULT_TEMPLATE_WEIGHTS` table the live fallback uses); `htfContext` is present on 360 of 360 day_trading rows; all seven categories are present on every row so nothing is redistributed away; and `composite = sum(weight * categoryScore)` reproduces the stored score to four decimals
- **One reading left open and explicitly not a live artifact**: the `futures` category averages **-49.1** across both styles and every symbol while `trend` averages +46.2 and `htf` +36.7. The composite is small because categories disagree, not because any is weak (positive contributions 18.3, negative -6.3, net 12.0). Since the research path reproduces live bar for bar, whatever produces -49.1 lives in the shared scorer, not in live scoring, and whether an almost-always-bearish category is informative or miscentred is the same shape of question the v6 scale work answered three times
- 10 tests on the pure helpers, including that non-finite values are dropped rather than counted as zero, which would otherwise drag every percentile down and look like a quiet market


### Measured (signals): the configVersion 7 re-calibration, and the half of it that cannot be measured
- **29 and 37 stand, measured rather than assumed.** A fresh export `f470933e` was taken from production after the deploy and scored three times over the same data: the v6 scorer on the old loose snapshot join (the control), the v6 scorer on the new causal join, and v7 on the causal join. The control **reproduces the recorded v6 table exactly**, percentile for percentile and bar count for bar count (5m 27.3/36.6 on 808,517 bars, 15m 30.3/37.3, 1h 32.2/38.4, 4h 28.9/36.4, 1d 26.3/36.7), so the new export is measurement-equivalent to `e705b347` and every difference is attributable to code
- **The causal snapshot join moves at most 0.2 points** at any percentile: p90 mean 29.0 to 29.1, p98 mean 37.1 unchanged. A correction worth 45 minutes of lookahead on one category's inputs barely reaches the composite, which is itself informative: the lookahead mattered to the research columns, not to live tiering
- **The v7 run is bit-identical to the v6-causal run, and that is not evidence the news repair does nothing.** `score-percentiles` scores history from the stored `data.newsSentiment` aggregate, written at ingest time by the old code; only `{count, avgSentiment}` is persisted, never the article text. **No historical re-run can re-derive it**, so the historical measurement is blind to v7 by construction and will stay blind until enough post-deploy snapshots exist to measure on their own
- **So the news change was measured the only way it can be**: both builds run against the same live feed inside one 5-minute cache window, seeing an identical article set. Across the ten signal symbols BTC moved 0.0500 to 0.0475 and SOL 0.2000 to 0.2400, the other eight were unchanged or had no articles, **no symbol's News signal changed gate state**, and no near-duplicate cluster existed in that window to collapse. One snapshot of one feed bounds the typical effect, not the worst case: the audit's measured cases were not in the window
- The `funding-z-fade` header comment asserted that no execution-lag shift was needed because "snapshots align to the bar's OPEN" -- the exact premise the audit falsified. Corrected in place, naming the date and that every recorded funding-z-fade number predates the fix

### Verified (research): `funding-z-fade` re-run on the corrected join, and the recorded verdict stands
- **The family built on the contaminated columns was re-run as a control, not as a new trial.** `funding-z-fade` at 1h and 15m, four runs over the same fresh export, lockbox applied, identical flags: the old loose join against the new causal one
- **The control reproduces Phase 4c exactly on a different export.** 1h point estimate **-0.1426%** against the recorded -0.143%, 15m **-0.0750%** against the recorded -0.075% with timing p **0.0050** against the recorded 0.005. That is what makes the comparison below readable

| interval | build | trades | point % | CI low | timing p | gates passed |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1h | v6, loose join | 2,244 | -0.1426 | -0.3491 | 0.0896 | sample |
| 1h | v7, causal join | 2,574 | -0.1111 | -0.3054 | 0.0249 | sample, timing |
| 15m | v6, loose join | 1,602 | -0.0750 | -0.1944 | 0.0050 | sample, timing |
| 15m | v7, causal join | 1,463 | -0.0915 | -0.1885 | 0.0050 | sample, timing |

- **Both still fail, and nothing in the record flips.** Every CI spans well below zero, observed Sharpe is negative in all four runs, and the deflated Sharpe probability is at or near zero throughout. Removing 45 minutes of lookahead from the inputs did not turn a losing rule into a winning one, which is what was predicted in writing before the run
- **The 1h timing gate now passes (p 0.0896 to 0.0249) and this is explicitly NOT a finding.** It is an observation from a control run rather than a pre-registered test; the shift changes which bars trigger, so it is not the same trade set (2,244 to 2,574); and it is sign-inconsistent with 15m, which moved slightly the other way (-0.0750% to -0.0915%). One gate crossing among sixteen gate evaluations is what this program's own multiplicity work says to expect from noise. Acting on it would be picking a hypothesis after seeing the data, which the phase rules forbid
- The honest summary of the join fix's effect on results: **it moves numbers by less than the noise between two adjacent intervals, and it changes no conclusion.** Its value is that the inputs are now causal, so future funding work starts from a correct base


### Fixed (signals): the news input was lexically broken, and is now configVersion 7
- **Keyword matching was substring.** `includes('ban')` fired on bank, banking, interbank, urban, Albania, bands and banner, so an institutional **bank-adoption headline scored BEARISH**; `gain` fired on "again" and `rise` on "surprise". Matching is now anchored on non-alphanumeric boundaries, the same rule `filterByCurrencies` already used to choose the articles in the first place
- **The list was unstemmed**, so `rally` missed "rallies" and "rallied", `hack` missed "hacked", and neither "bullish" nor "bearish" matched anything at all -- the two commonest words in crypto headlines. Each keyword now carries its regular inflections, with the `y` ending and the silent `e` (decline, declining) handled explicitly. A dependency-free rule is enough for thirteen words per direction
- **Selection and scoring disagreed.** Articles are selected on title, body and categories; 35% of attributed articles had titles that never named their symbol, and the body that won them their place was never read. The body is now scored at 0.4 of the title's weight, on the reasoning that a headline is written to characterise a story while a body mentions many things in passing. Distinct keywords, not occurrences, so a press release repeating "rally" forty times cannot saturate the clamp on one word
- **Dedupe was by publisher URL only.** One Solana press release rewritten by four outlets supplied 4 of that symbol's 7 articles and was the entire reason its score sat at 0.129, just under the gate. `dedupeAndSort` now runs a second pass clustering titles by Jaccard similarity at 0.8, which collapses a rewrite while leaving two stories that merely share a subject alone ("Bitcoin climbs above 70,000" and "Bitcoin miners report record hashrate" share one content word in nine)
- **The gate is UNCHANGED at `count >= 3` and `|avg| >= 0.15`.** Cleaning an input and loosening the threshold that was containing it in the same change would leave neither testable. Measured per-event noise before the fix was 0.60 against that 0.15 threshold, four times it
- **configVersion 7.** News scores before and after are not comparable, so v6 and v7 composites are not either. The tier cutoffs are **not** re-measured: the effect is bounded (sentiment is 0.09 of the default weights, News is one of its two signals, and it only fires past the gate) and a re-measurement needs a fresh production export that does not exist yet. `calibration.ts` records that as an open item with the control methodology, rather than carrying a guessed number
- 16 news-sentiment tests including every measured false positive, and two clustering tests


### Fixed (research): the snapshot join read data captured after the bar it was stamped for
- **A snapshot stamped T does not hold the market at T.** `ingest-snapshots` stamps `alignTimestamp(now, interval)` while fetching every field at `now`; the 1h line runs every 15 minutes so all four runs of an hour floor to the same stamp, and `mergeSnapshotUpdate` `$set`s per field on upsert, so the last run wins. A row stamped 12:00 routinely holds **12:45** data. `buildSnapshotSeries` then handed that row to the bar opening at 12:00: **45 minutes of lookahead at 1h**, and up to **nine bars at 5m**, since 1m/5m/15m candles read 1h snapshots through `mapToSnapshotInterval`
- **Fixed at the single source rather than per consumer.** The join now requires `snapshot.timestamp + snapshotInterval <= candle open`, so a reading captured anywhere inside a snapshot's window is used only from the bar after that window closed. One change covers `factors.ts`, `research-columns.ts`, the backtest engine, the strategy harness and the exposure harness; a strict `<` would not have been enough, because a 5m bar at 12:05 sits inside the window the 12:00 row was captured in
- **The staleness cap moves from 2 to 3 intervals**, since one interval is now spent on the causality shift itself. That preserves exactly the previous tolerance for a missed ingest tick rather than silently tightening it
- **What this costs.** `longShortRatio` was already causal on archive-backfilled bars, because `archive-ingestion.ts` wrote it strictly; it is now read one bar later than it strictly needs to be. Stale by one bar is the conservative direction, and the alternative was carrying the loose case for the sake of the strict one
- **What no longer reproduces.** Every snapshot-derived IC recorded before today was measured on the looser join: `raw.fundingRate`, `raw.fundingZ`, `raw.fearGreed`, `raw.longShortRatio` and the `fundingZ*d` / positioning columns. The recorded numbers stand as a record of what was measured, not as values a re-run will return. Direction is unaffected in the one case it was acted on: `funding-z-fade` lost money on the contaminated inputs and a strictly causal input cannot make a losing rule profitable. **The dataset manifest hash is NOT affected** -- the export stores raw snapshot rows and the columns are built at read time
- Three contract comments that asserted the old rule are corrected in place (`research-columns.ts`, `factor-ic.ts`, `archive-ingestion.ts`), each naming the date and what changed, so a future reader cannot take a pre-2026-09-25 number for a post-fix one
- 13 snapshot-series tests, including the fine-candle case a strict `<` would miss, and two existing research tests updated to the shifted window rather than to pass


### Removed (signals): every user-reachable path that could score on demand
- **A browser click could write into the live signal record.** The signals page carried a "Compute Now" button calling `POST /api/signals/compute`, which ran `computeSignalBatch` and persisted a `GlobalSignal` at a moment no cron fired. That is the same collection the `configVersion` live record is read from and the outcome resolver builds pending outcomes from, so a user-triggered row is indistinguishable from a scheduled one after the fact. Scoring now happens only on the schedule
- **The legacy per-user scorer is retired.** `*/10 * * * * /api/cron/compute-signals` with no `style` ran `computeLegacySignals()`: a third scorer on `DEFAULT_CONFIG` periods, `DEFAULT_WEIGHTS`, no higher-timeframe context, no news and no `configVersion`, writing one `Signal` document per user strategy. Its only reader was the journal's indicator snapshot, which now computes its own, so it was producing numbers nobody read. The cron line, the `CRON_JOBS` entry, the no-style branch and the route's `Strategy`/`Signal` machinery are gone, and omitting `style` is now a 400
- **Gone with them:** `POST /api/signals/compute`, `GET /api/signals` (the per-user list), the `Signal` model and its 90-day TTL index, and the `useSignals`, `useLatestSignal`, `useComputeSignal` and `useComputeGlobalSignal` hooks, none of which had a call site left. `ISignalComponent` moves to `models/global-signal.ts`, which is the only thing that still persists that shape
- **Existing `signals` documents are untouched.** Dropping a Mongoose model does not drop its collection; the rows simply expire on the TTL they already carry
- **Deploy note:** the cron container must be recreated for the removed line to take effect -- `docker compose -f docker-compose.server.yml up -d --force-recreate cron` -- because the deploy workflow never recreates it


### Fixed (journal): the pattern detector praised a small sample it would not criticise
- **"Profit factor of 2.50 indicates strong risk-reward management" had no sample guard while its warning twin required five closed trades.** One +5% win against one -0.5% loss produced it. Both branches now sit behind the same `MIN_CLOSED_TRADES_FOR_PATTERN`, on the reasoning that an encouraging claim off a thin sample is not the safer of the two: it is the one more likely to be acted on

### Fixed (journal): the indicator snapshot was reconstructed by regexing prose, and mostly failed
- **What a journal entry recorded was not what the chart showed.** `useIndicatorSnapshot` called `/api/signals?symbol=...&limit=1` and rebuilt the twenty-field reading in the browser by pulling the **first number out of each signal's description sentence**. `ISignalComponent` persists `name`, `direction`, `strength` and `description` and drops the numeric `value` the interpreter had already computed, so the client was re-deriving from text what the server had thrown away
- **Three independent failures, all silent.** Eight of twenty fields were never populated at all (both Bollinger bands and the middle, both EMAs, both SMAs, the MACD signal and histogram, StochRSI D) because no description carries their value, so the detail view's labelled grid had nothing to show. `"OBV above 20-period average by 4.2 bars of volume"` yields **20**, the period of the comparison average, so every entry recorded an OBV of exactly 20. `"MACD bullish, histogram 2.3x its recent average"` stored a dimensionless multiple under `macdLine`. `"High volatility (ATR: 1.25% of price)"` stored a percentage under a field labelled ATR
- **The interval argument was accepted and ignored.** The query carried `symbol` and `limit=1` only, so the reading came from whichever `Signal` the legacy per-user cron had last written, at whatever interval that user's strategy covered, while the journal form believed it had asked for a specific one. With no active `Strategy` there are no such documents at all and every capture was silently null
- **The unit tests had certified this path against strings the interpreter never emits.** The fixtures read `"RSI at 62"`, `"StochRSI K at 75"` and `"ATR at 500"`; production emits `"RSI bullish momentum at 62.4"`, `"StochRSI neutral (K: 75.0)"` and `"High volatility (ATR: 1.25% of price)"`. The parser passed eight tests because the tests were written to the parser rather than to the producer
- **New `/api/indicators/snapshot`** computes the reading from the indicators themselves for the symbol and interval asked for, at the last **closed** bar (same `dropOpenBars` and same 60s cache key as the compute-signals cron, one `now` for the whole request), and stamps `candleTimestamp` so a recorded snapshot can be checked against the chart later. ATR is reported in price units, matching its label and every other level in the grid; the percent-of-price form is a strength input, not a reading. Too little history is a 422, an open bar is a 503, and a missing Fear and Greed reading costs only its own two fields
- **This leaves the legacy per-user scorer with no consumer.** `useSignals`, `useLatestSignal` and `useComputeSignal` have no call sites anywhere in the app, so the `*/10` cron that runs `computeLegacySignals()` now writes `Signal` documents nothing reads. Retiring it is a production change and is left as a decision, not taken here
- 18 new tests: 6 pinning each field to its indicator rather than its sentence, 8 on the route including the closed-bar and 422 paths, and 4 rewritten hook tests


### Fixed (journal): an average P&L stated from samples the same panel refused to state a rate for
- **`avgPnlPercent` was never gated while `winRate` beside it was.** The previous pass added `ANALYTICS_MIN_SAMPLE_FOR_RATE` and returned `winRate: null` under five trades, and left the average untouched. The result was a row rendering a dash in the Win Rate column and a coloured, signed percentage two inches to its right, computed from the same one or two trades. That is arguably worse than the original bug: the dash advertises that the statistics were checked, which makes the number next to it read as the part that survived the check
- **A mean has worse small-sample behaviour than a rate, not better.** One outlier moves an average without bound while a rate is capped at 100, so if either field deserved suppression first it was this one. All nine breakdowns (tag, setup, market condition, signal tier, session, hour, weekday, emotion, mistake) now go through `avgOrNull` on the same threshold as the rate
- **The summary card is deliberately left alone.** It averages every closed trade, which is the same population Kelly already guards with its own `reliable` flag; gating it would blank the headline of an early journal for no gain in honesty
- **The types carry the change, so a future panel cannot reintroduce it.** Widening the nine `avgPnlPercent` fields to `number | null` made the compiler name all four render sites, including `WinRateByTag`, which formatted the value inline. `formatAvgPnl` and `avgPnlColorClass` join the existing `formatWinRate` helpers so the null handling stays in one place, and the shared `PnlValue` component in the psychology and timing panels takes the nullable value directly
- 4 new helper tests plus a route test pinning both sides of the threshold: three trades reports `null` with the total still shown, five trades reports the average

### Fixed (tooling): `npm run lint` could not reach zero errors
- **A git worktree lives inside the repo at `.claude/worktrees/<branch>`, and ESLint was linting it**: 891 files, 2852 errors, all of them a second copy of this tree plus its own `.next` output. Git already excludes the path through `.git/info/exclude`; ESLint did not, so the per-step rule of zero lint errors was unsatisfiable for as long as any worktree existed. Added to `globalIgnores` beside `_reference/**`, which is there for the same reason. Real output is now 0 errors and 8 pre-existing warnings


### Fixed (ops): the archive ingest ran inside the publication window, and a not-yet-due job read as broken
- **The two ingest crons move from 05:30 and 06:00 UTC to 10:00 and 10:30, and the time is measured rather than guessed.** On 2026-09-25 the previous day's metrics file was still a **404 at 01:34Z and a 200 by 07:48Z**, so publication lands inside that window and an 05:30 run sat in the middle of it: sometimes it caught the day, sometimes not. The observed consequence was that `futuresmetrics` and `perpcandles` habitually sat **two** days behind rather than the intended one, catching up only on the following run (they were at 2026-09-22T23:55Z and moved to 2026-09-23T23:55Z when triggered by hand). 10:00 clears the latest observed publication by over two hours, and the rationale plus the re-measurement recipe are recorded in `docker/crontab.template`
- Both `docker/crontab.template` and the `CRON_JOBS` table move together, which `cron-jobs.test.ts` enforces as a bijection

### Fixed (ops): a health check that went red for a day after every cron container recreate
- **`/api/health/cron` returned 503 for a job that had never run, without asking whether it had yet had the chance to.** `classifyJob` already separated `never_ran` from `overdue` on the principle that an absence is not a lateness, and then `isAllHealthy` discarded the distinction. Recreating the cron container leaves a daily job with no heartbeat for up to a day, so the endpoint reported a fault where there was only a gap in observation. That is how a health check trains people to ignore it
- **New `pending` state**, meaning has not run and has not yet had the chance to. `classifyJob` takes an optional `observedSinceMs`, and the route reads it as the **oldest heartbeat's `createdAt`**: heartbeats live in Mongo and survive a recreate, so that is the honest anchor rather than process start. The threshold is the same `expectedEverySeconds + grace` a run would have to miss to count as overdue, so the two cannot drift apart
- Omitting `observedSinceMs` keeps the old behaviour, and a job that HAS run and then went stale is still `overdue`, never rescued. With no heartbeats at all there is no anchor, so everything reads `never_ran` as before
- 7 new tests including the boundary (pending at exactly 90120s for a daily job, never_ran one second past it) and the real outage shape at route level: a daily job with no heartbeat while recording began an hour ago returns **200 with `pending`**, not 503


### Research (Stage 2, 2026-09-25): both direct predictions held, the conditioning hypothesis is falsified, and Stage 4 stays shut
- **Measured at 5m, 1h and 4h in one pass**, so no interval was chosen after seeing another's result. Controls reproduce the recorded lag-1 table exactly at all three: `raw.ret1` h1 is -0.0231 at 5m, -0.0291 at 1h, -0.0157 at 4h
- **`raw.varianceRatio` is not a survivor anywhere**, as pre-registered: a regime reading is not a direction
- **`raw.fundingProximity` is not a survivor either, and is strictly WEAKER than the `raw.fundingZ` it was built from** at every interval (1h h8: -0.0170 against -0.0234; 4h about zero against -0.0152). Weighting funding by distance to its settlement destroys signal rather than adding it, so the event-time axis contributes nothing and the funding level alone remains the better column
- **The falsification fired, and how it fired is the useful part.** The criterion fixed in advance was that if the TREND subset's reversal IC is as negative as the MEAN-REVERSION subset's, the ratio is mis-signed or measuring nothing

| interval | h | uncond | revert | trend | gap vs uncond | direction |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 5m | 2 | -0.0261 | -0.0229 | -0.0327 | 38% | **trend deeper** |
| 5m | 4 | -0.0245 | -0.0223 | -0.0289 | 27% | **trend deeper** |
| 1h | 1 | -0.0291 | -0.0302 | -0.0270 | 11% | revert deeper |
| 1h | 2 | -0.0268 | -0.0271 | -0.0260 | 4% | revert deeper |
| 4h | 4 | +0.0030 | +0.0123 | -0.0125 | 828% | **trend deeper** |

- **The direction is inconsistent across intervals** -- trend-deeper at 5m and 4h, revert-deeper at 1h, and at 1h every gap is at or below the one-third threshold fixed in advance. A conditioner that points one way at 5m, the other at 1h and back again at 4h is not measuring a stable regime
- **The likeliest reading is consistent with what the program already knows.** A high variance ratio means the recent past TRENDED, and Phase 3 established that trend-following inputs are wrong-signed intraday. So the ratio is picking up recent momentum, which is already contrarian and already carried by `raw.ret1` and the momentum columns. It adds nothing orthogonal
- **`raw.ret1InMeanReversion` and `raw.ret1InTrend` do clear the survivor rule at 5m and 1h, and that is not a finding**: they are subsets of `raw.ret1`, which clears it too. They are diagnostics, not new inputs
- **One residue, deliberately not chased.** At 4h the split produces a genuine SIGN FLIP rather than a magnitude difference (h4 revert +0.0123, trend -0.0125). That is a different claim from the one tested, at the sample-limited interval, so acting on it would mean flipping a hypothesis after seeing the data. It belongs in a new pre-registration or nowhere
- **Stage 4 stays shut.** Its gate was that Stages 0 to 2 produce at least one factor surviving at a fine interval. No new input did, so the trade-level ingest -- roughly 232 GB, a streaming parser with no precedent in the codebase, about 17 files -- is not started. The cheap stages did their job, which was to be cheap enough to say no with


### Added (research): Stage 2 regime and funding-cycle columns, with predictions recorded first
- **`raw.varianceRatio`** is Lo and MacKinlay's VR(q) = Var(r_q) / (q * Var(r_1)) over a 120-bar trailing window at q=4. A random walk has independent increments, so a q-bar return has q times the variance of a one-bar return and the ratio is 1; above 1 the series trends, below 1 it reverts. Written with running sums so the cost is one pass regardless of window size, the same reason `trailingZScore` is. The simple ratio, not the bias-corrected estimator: the correction matters for testing the null VR = 1 and not for a monotone regime indicator, which is all it is used as
- **`raw.ret1InMeanReversion` and `raw.ret1InTrend`** are the same one-bar return split by the regime its bar sits in, and they are the actual hypothesis. A raw IC of the ratio itself would ask whether the regime predicts direction, which is not what a conditioner claims. Comparing the two ICs asks the question the ratio exists to answer: does knowing the regime tell you when reversal works
- **`raw.fundingProximity`** weights the funding rate by how close the bar closes to the next 8h settlement. Everything in this program is measured in clock time or bar count; nothing has ever used an **event-time** coordinate, and the settlement clock is known in advance. `FUNDING_INTERVAL_MS` is imported from `funding.ts` rather than restated
- **Predictions, recorded before measuring.** `varianceRatio` direct: no survivor, it is a regime reading and a survivor would more likely mean it proxies volatility. The two regime splits: both negative, since Phase 3 found reversal dominates intraday, but **materially more negative in the mean-reversion subset** -- the conditioner earns its place only through that gap. `fundingProximity`: weak negative, probably no survivor, the same contrarian direction `fundingZ` already shows
- **A falsification fixed in advance:** if the trend subset's IC is as negative as, or more negative than, the mean-reversion subset's, the variance ratio is either mis-signed or measuring nothing here and no further work should be done on it. A gap smaller than about a third of the unconditional \|ic\| counts as no gap
- **Measured at 5m, 1h and 4h in one pass**, not one interval at a time. Stage 1 had to add intervals after seeing its first result, which makes the later ones post-hoc; doing all three together avoids repeating that
- 5 new tests including the analytic case: a perfectly alternating series has every 4-bar log return exactly zero while 1-bar returns are not, so VR must read 0, and the two regime columns must partition the one-bar return with neither overlap nor gap


### Research (Stage 1, 2026-09-25): three free depth columns measured, none survives
- **Built from data that was already exported and never read.** `depthNotional1` and `depthNotional5` have always been written into `MetricsRow` by `export-dataset.ts` and appeared nowhere in `factors.ts`. No ingestion, no re-export, two edit points each
- **`raw.depthFlow1` needs no reconstruction of each side of the book.** With `N` the notional on both sides and `I` the imbalance, `bid - ask = N * I` identically, so the order-flow imbalance `(B_t - B_{t-1}) - (A_t - A_{t-1})` collapses to `N_t*I_t - N_{t-1}*I_{t-1}`, scaled by `N_t`. One documented approximation: both inputs are means over the 5m slot, so their product is not the mean of the product unless sum and ratio are uncorrelated within the slot
- **Controls reproduce the recorded lag-1 table exactly**, which is what makes the new rows readable: `raw.ret1` h1 is -0.0231 at 5m and -0.0121 at 15m, and `raw.depthImbalance1` at 4h is h8 -0.0269 t-4.9, h16 -0.0408 t-5.8, h32 -0.0515 t-5.7

| factor | 5m best | 1h best | 4h best | verdict |
| --- | --- | --- | --- | --- |
| `raw.depthFlow1` | +0.0092 t+8.0 | +0.0073 t+4.3 | -0.0074 t-2.7 | \|ic\| below the 0.02 floor |
| `raw.depthNotional1` | +0.0127 t+2.6 | -0.0027 t-1.3 | +0.0026 t+0.4 | quarter agreement 0.45 at 15m |
| `raw.depthSlope` | -0.0118 t-2.4 | +0.0076 t+2.0 | +0.0049 t+1.2 | nothing anywhere |

- **Nothing survives at any interval and the pre-registered kill criterion fires**, so the phase ends with no harness run. The FDR correction was not needed: nothing cleared even the unadjusted rule, and FDR only tightens
- **The sign prediction for flow was right and the size was not.** `depthFlow1` is positive at the fast horizons, opposite to `depthImbalance1`'s contrarian reading, exactly as pre-registered: a crowded book LEVEL is faded while the FLOW that builds it is followed. It decays monotonically with horizon and flips negative by 4h, which is coherent rather than noisy. At t+8.0 on the 5m pool it is a real effect, and at 0.0092 against a 0.02 floor it is about half the size the rule demands
- **`depthNotional1`'s failure mode is instructive.** Its 15m reading (h16 +0.0248, h32 +0.0337, symbol agreement 0.80) fails on QUARTER agreement at 0.45: it works across symbols and not across time, which is the signature of a non-stationary level rather than a forecast. The program already met this on positioning and answered it with a trailing z within symbol. A z-scored depth notional is the obvious next column and is deliberately NOT added here, because choosing it after seeing this result is what inflates a search

### Fixed (analysis): the interval to hunt at is 1h, not 5m
- **A correction to Stage 0's own reasoning, made mid-phase and recorded because it changed which intervals were measured.** Stage 0 compared barriers in percent per trade and concluded 5m was the place to look, because its statistical bar is 0.010% against 0.450% at 4h. That is the wrong comparison: **cost is fixed** at about 0.040% a round trip while the return a trade can earn scales with holding period. Restating both as a required information coefficient, `ic = bar / (2 * sd per trade)`:

| interval | sd %/trade | ic to pay cost | ic detectable | binding |
| --- | ---: | ---: | ---: | --- |
| 5m | 0.71 | 0.0282 | 0.0070 | cost |
| 1h | 4.56 | **0.0044** | **0.0113** | sample |
| 4h | 8.12 | 0.0025 | 0.0277 | sample |

- **1h needs the smallest ic, 0.0113, and is the only interval where anything detectable is also tradable.** 5m carries a band of effects that can be seen but not traded (0.0070 to 0.0282); 4h carries a band that could be traded but not proven (0.0025 to 0.0277). At 1h `depthFlow1` needs 0.0113 and delivers 0.0073, short by about 1.6x, the closest this program has come at a fine interval
- **A consequence for the survivor rule itself:** its fixed `minAbsIc` of 0.02 implies a gross edge of only about 0.028%/trade at 5m, which is below the 0.040% maker cost bar. At 5m the rule can admit an effect too small to trade, and at 4h it rejects effects that would pay eight times their cost. The floor is interval-blind and the cost bar is not. Not changed here, since altering a survivor rule mid-phase is exactly what pre-registration exists to prevent


### Research (Stage 0, 2026-09-25): maker entry makes the best result WORSE, and that closes a direction
- **Ran on dataset `e84cd66dbe01`, lockbox applied, 10 symbols, 6 windows, `--start 2023-01-01`, `--trials 358`** (Phase 4c's 342 plus these 16 cells, so every cell tried on the way to the claim is counted). One random symbol-window re-run with `--cell --report` and reproduced digit for digit

| family | interval | trades | exp% | CI low | timing p | gates failed |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| depth-imbalance-fade-limit | 4h | 1,035 | **-0.1919** | -0.6830 | 0.736 | **7 of 8** |

- **It failed as predicted, but not for the predicted reason, and the reason matters more than the verdict.** The pre-registered prediction was that maker execution would lift +0.090% to about +0.190% and still miss a 0.450% bar. Instead expectancy went to **-0.1919%**. Decomposing at approximate costs (taker ~0.14% round trip at 4h, maker 0.04%; the exact blend varies because `exitFillKind` prices a take-profit as maker): gross moved from about **+0.230% to about -0.152%**, so a fee saving of ~0.10% was swamped by a gross deterioration of **~0.38%**. Trades fell 1,251 to 1,035 as unfilled orders dropped out
- **The mechanism is adverse selection, and it is structural.** `withLimitEntry` rests the order at the decision close, so a short fills only if price RISES to it and a long only if price FALLS to it: a fill requires the market to move against the trade first. For a family whose thesis is fading a crowded book, that means being filled precisely on the entries where the fade was early and skipping the ones that worked immediately. **A passive entry on a mean-reversion signal is not a cheaper version of the same trade, it is a different and worse trade**
- **This retro-explains Phase 4 rather than contradicting it.** `control-limit` at 1h recovered only 0.041% (-0.063% to -0.022%) of a ~0.10% fee saving, and widening the offset grid to 20 and 30 bps did not help. Same mechanism, milder, on families that are also reversal-shaped: a larger offset buys a better price at the cost of a still more adversely selected fill, and the two roughly cancel
- **Consequence for the search.** The 0.04% maker cost bar is not available to a reversal entry, so "find an edge above 0.04% and execute passively" is the wrong target for this family shape. Either the signal must be continuation-shaped, where resting an order is favourably selected because the fill comes on a pullback that then resumes, or the edge must clear the full taker cost. Per the standing ruling, no third rule shape on this input

### Added (research): depth-imbalance-fade-limit, with its outcome predicted before the run
- **The program's only positive result has never been priced for maker execution.** `depth-imbalance-fade` at 4h is +0.090%/trade over 1,251 trades, the first family to clear the symbols gate (7/10) and the first positive point estimate to survive stress (+0.005% at 1.5x fees and 2x slippage). It was measured against a **taker** cost model. `withLimitEntry` has existed since Phase 4 but reached only `control`, `return-reversal` and `oscillator-reversion`, at 5m and 1h -- never the depth, positioning or funding families, and never 4h. A maker round trip is 0.04% against roughly 0.14% taker at 4h
- **The prediction is recorded before the result, and it is that this FAILS.** Recovering per-trade dispersion from the Phase 4c bootstrap CI half-width (`sd = half * sqrt(n) / 1.96`) gives about 8.12%/trade at 4h, so the edge needed for the CI low bound to clear zero at n=1,251 is about **0.450%**. Maker execution is worth roughly the 0.10% cost difference, lifting +0.090% to about **+0.190%**: a better point estimate, still less than half the bar. Proving +0.090% at that dispersion would take about **31,275 trades**. Writing the prediction down first makes the run a test of the dispersion estimate as well as of the strategy
- **Why this matters beyond one family.** The same arithmetic across intervals shows the two barriers sit at opposite ends: at 5m the statistical bar is 0.010% against a 0.040% maker cost bar (cost-limited, 4x margin), while at 4h it is 0.450% against 0.040% (sample-limited, 11x). The program's best signals live where they cannot be proven, and its abundant sample lives where costs eat it. Widening the symbol universe does not help: effective independent symbols are `m/(1+(m-1)rho)`, which at a crypto rho of 0.7 moves from 1.37 at ten symbols to 1.43 at two hundred
- `k` is fixed at 3 rather than swept, because `MAX_PARAMS` is 4 and the base family already uses four. The choice is empirical, not arbitrary: reading `selectedParams` out of `strategy-depth-imbalance-fade-4h-p4c.json`, **all five of the most-selected cells carried k=3** (days 90/z 2/hold 32 and days 30/z 2/hold 32 at nine windows each, then days 30/z 2/hold 16, days 30/z 1.5/hold 32 and days 90/z 1.5/hold 32). The reduced grid keeps every one of them: days [30,90] x z [1.5,2] x hold [16,32] x timeout [1,2], 16 cells, the same size the other limit families use
- 7 new tests: the registry, the grid with all five dominant Phase 4c cells asserted inside it, the required research columns, limit entry at the close on a heavy bid book, the long side and the days-column selection, the z threshold, and causality under truncation
- **A coupling worth recording:** `parseArgs`'s `defaultTrials` is `gridCells x familyCount`, so adding any family silently moves the default for every other one. That is why each phase overrides it with an explicit `--trials` fixed for the whole phase, and the harness test now says so


### Fixed (research): the random-entry null did not reproduce the reference's trade count
- **The null behind the `timing` gate was matched on the wrong thing.** `randomEntryBenchmark` exists to vary ENTRY TIMING while holding the exit profile fixed, so the reference and the null should differ in when they enter and in nothing else. They also differed in how often: measured, the null traded **1.17x to 1.32x** as often as the reference it was compared against
- **`referenceProfile`'s arithmetic was right and its assumption was not.** With entry probability `p` on each flat bar, expected trades solve `T' = p * totalBars / (1 + p * h)`, and at `p = T / (totalBars - T * h)` that is exactly `T` -- but only when `h`, the hold the null realizes, equals the reference's. It never does. The reference's `holdTimeBars` are **realized** holds that already embed its own stop and target hits, and `createRandomEntryStrategy` then re-applies the stop AND the target AND caps the trade at that realized hold via `timeStopBars`, so a random trade gets three chances to be cut short where the reference's outcome was already settled
- Measured, the null's mean hold is a consistent fraction of the reference's, and the trade count follows arithmetically:

| series | reference trades | ref mean hold | null mean hold | hold ratio | count ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| 600 bars, threshold 15 | 5 | 46.60 | 35.81 | 0.768 | 1.165 |
| 1200 bars, threshold 15 | 14 | 41.36 | 31.85 | 0.770 | 1.166 |
| 600 bars, threshold 10 | 8 | 42.38 | 32.13 | 0.758 | 1.291 |

- The exit reasons show the mechanism directly: on the 600-bar series the reference exited 3 by `take_profit`, 1 by `signal` and 1 by `end_of_data`, while 40 null draws exited 89 by `stop_loss` and 90 by `time_stop`
- **`randomEntryBenchmark` now calibrates the entry rate against the hold the null actually realizes**, via a seeded fixed-point pass: 8 pilot draws per round, at most 3 rounds, stopping early once the rate moves less than 1%. The arithmetic is the new pure `entryProbabilityForTargetTrades(targetTrades, totalBars, meanRealizedHold)`, which is `referenceProfile`'s own expression evaluated at the realized hold rather than the reference's. Pilot seeds sit on a separate stream (`CALIBRATION_SEED_OFFSET`, the same separation `exposure-harness.ts` uses for its timing draws), so a report still reproduces exactly
- **The null now matches on count**, and the p-value impact is small and in the conservative direction:

| case | null trades before | null trades after | p before | p after |
| --- | ---: | ---: | ---: | ---: |
| 600 bars, 5 reference trades | 1.218x | **1.031x** | 0.0348 | 0.0448 |
| 1200 bars, 14 reference trades | 1.195x | **1.025x** | 0.0050 | 0.0050 |
| 1200 bars, 17 reference trades | 1.271x | **1.031x** | 0.0050 | 0.0050 |
| 2000 bars, 27 reference trades | 1.261x | **1.005x** | 0.0050 | 0.0050 |

- **This does not overturn a recorded `timing` verdict, with one row worth re-running.** The compared statistic is per-TRADE expectancy, so the null's mean barely moves with its count (1.9759 to 1.9831 in the one case not pinned at the p floor), and the shift is about +0.01 on p, i.e. slightly LESS significant. Every recorded run that failed `timing` fails it at least as clearly. The exposure is a run sitting just inside the 0.05 threshold, and Phase 4c has one: **`depth-imbalance-fade` at 1h, recorded `timing p 0.045`**, which is within the measured shift and could move to failing. That run already failed 6 of 8 gates, so its verdict is unchanged, but the gate row should be re-run before anyone cites it
- `randomEntryBenchmark` additionally returns `meanRandomTrades` and the calibrated `entryProbability`, so a caller can see whether the null matched on count. Deliberately NOT added to `StrategyReportSchema`: that schema strips unknown keys silently, and widening the persisted shape is a separate change. Worth doing, since a silent calibration is exactly what should be visible in a report
- 7 new tests: the null reproducing the reference count at three configurations through the real code path, a regression guard pinning that the RAW profile over-trades so the calibration cannot be silently removed, and four on the pure arithmetic including the degenerate case where the target leaves no flat bars


### Fixed (signals): three indicator strength scales that measured the asset, not the market
- **MACD strength was a function of nominal price.** `interpretMACD` used `min(100, |histogram| * 1000)`, and the MACD histogram is a difference of two EMAs of price, so it is denominated in the symbol's own price units (`computeMACD` passes `SimpleMAOscillator: false`, so it is `EMA - EMA` of raw closes, not a ratio). Measured at 1h over 41,102 bars per symbol, median strength was **100.0 for BTCUSDT (saturated on 99.9% of bars) and 0.2 for DOGEUSDT (below 5 on 99.9% of bars)**. Momentum is the highest-weighted category for scalping (0.34) and day trading (0.255), so for expensive assets it contributed maximum conviction on essentially every bar and for cheap ones nothing at all

| symbol | median price | median MACD strength | share saturated at 100 | share below 5 |
| --- | ---: | ---: | ---: | ---: |
| BTCUSDT | 58,622 | 100.0 | 99.9% | 0.0% |
| ETHUSDT | 2,379 | 100.0 | 97.6% | 0.1% |
| SOLUSDT | 103 | 100.0 | 58.6% | 3.1% |
| LINKUSDT | 12.75 | 18.9 | 5.4% | 16.3% |
| XRPUSDT | 0.62 | 0.9 | 0.0% | 88.3% |
| DOGEUSDT | 0.11 | 0.2 | 0.0% | 99.9% |

- **That reached the tiers users see.** With global cutoffs, the share of bars above the buy cutoff at 1h ran **18.30% for BTC against 10.22% for XRP**, and above the strong cutoff **2.92% against 1.18%**, monotone in nominal price. A user watching BTC got roughly 80% more buy signals and 2.5x more strong signals than one watching XRP, for no market reason
- **`interpretEMACross` had the same defect across INTERVALS.** The spread is already a percentage, so it is scale-free across symbols, but its dispersion is not scale-free across intervals: measured over six symbols the pooled median `|spread|` runs **0.080% at 5m to 13.388% at 1d, a range of 167x**, so the fixed `* 20` gave a median strength of **1.7 at 5m and a saturated 100.0 at 1d**. The same input carried almost no opinion at one interval and maximum conviction at another
- **`interpretTakerFlow`'s fixed 0.55/0.45 band was wrong in two independent ways.** It was miscentred: across ten symbols the ratio's median is **0.492 to 0.495, never 0.5**, so a symmetric band fired bearish more often than bullish at every interval. And it was interval-blind: it caught **77.9% of 5m bars (55% of them pinned at the strength cap) against 6.3% of 1d bars**
- **All three now divide by the quantity's own trailing magnitude**, which is the same fix `interpretOBV` already used against the same class of defect. The divisor was chosen by measurement, not assertion. Normalised by a trailing mean, the pooled median holds within **1.10x** across all four intervals; percent-of-price leaves a 52x interval range and ATR multiples 1.9x (MACD) to 5.8x (EMA), so neither would have worked with one constant

| normalisation | pooled median at 5m / 1h / 4h / 1d | cross-interval range |
| --- | --- | ---: |
| `\|hist\| / close * 100` | 0.023 / 0.138 / 0.321 / 1.190 | 52x |
| `\|hist\| / ATR14` | 0.101 / 0.139 / 0.137 / 0.194 | 1.9x |
| `\|hist\| / trailing mean \|hist\|` | 0.858 / 0.897 / 0.883 / 0.941 | **1.10x** |

- **The measured result is cross-symbol comparability.** On the same export at 1h, the share above the buy cutoff moved from BTC 18.30% / XRP 10.22% / DOGE 10.89% to **BTC 14.36% / XRP 13.18% / DOGE 13.42%**, and the strong-tier ratio between BTC and XRP fell from **2.47x to 1.04x**. p98 now agrees across those symbols to within **0.07 of a point**, where it spanned 2.4 points before
- `computeEmaSpreadPct` carries the aligned per-bar spread on the raw set so neither interpret path has to align two EMA arrays of different warmup length itself, and `computeTakerBuyRatioZ` is shared by both paths so they cannot drift. Both take an explicit end index rather than a pre-sliced array, for the two reasons `interpretOBV` already documents: reading past the evaluated bar is lookahead (`no-lookahead.test.ts` enforces it), and slicing per bar is the O(n^2) allocation that exhausted a 4 GB heap on the 808k-bar 5m series
- **This is a known semantic change, not only a rescaling.** A self-normalised reading responds to a move away from recent behaviour rather than to a sustained level, so a long one-directional trend now reads near its own average instead of saturating. It is why the `strategy-families-limit` fixture had to change: a single-drift walk produced **zero** threshold crossings in its second out-of-sample window at any drift, noise level or seed, and had been crossing only because the old multipliers saturated on it. On real data this is not a scarcity problem, since 13% to 14% of bars still clear the buy cutoff

### Changed (signals): `GlobalSignal.configVersion` is 6, and the tier cutoffs are 29 and 37
- v5 and v6 scores are not comparable and tier-conditioned statistics must not be pooled across them. `SignalOutcome` carries the version through, so filter on it rather than on a date
- **The cutoffs were re-measured on a production export, not estimated.** v6 moves the distribution, so 30/38 had to be re-derived. Measured on `e705b347`, a fresh export of production taken 2026-09-25, lockbox applied
- **Why that export is comparable with the 30/38 table**, which was measured on `e84cd66dbe01`: running the UNCHANGED v5 scorer over it reproduces that table **exactly**, at every interval, in bar count as well as percentile. The post-2026-07-01 rows the newer export also carries are dropped by the lockbox, so for measurement purposes the two are the same data. That control is what makes the shift attributable to the scorer rather than to the export

| interval / style | bars | \|score\| p90 | \|score\| p98 |
| --- | ---: | --- | --- |
| 5m scalping | 808,517 | 28.7 -> 27.3 | 38.8 -> 36.6 |
| 15m day_trading | 320,847 | 30.3 -> 30.3 | 38.3 -> 37.3 |
| 1h day_trading | 411,013 | 32.4 -> 32.2 | 39.5 -> 38.4 |
| 4h swing_trading | 152,048 | 31.6 -> 28.9 | 40.2 -> 36.4 |
| 1d position_trading | 21,687 | 31.3 -> 26.3 | 42.0 -> 36.7 |

- The v6 bands are p90 **26.3 to 32.2** and p98 **36.4 to 38.4**, means 29.0 and 37.1. **29 and 37** are those means rounded, both inside their band, set by the same rule 30 and 38 were. They restore the selectivity these constants document (the most decisive tenth, the top fiftieth), which 30 and 38 no longer marked: at 30 the share ran 6.3% to 14.6%, and at 38 it ran 1.3% to 2.3%, so the strong tier had drifted to roughly the top sixty-fifth. `STRATEGY_EXIT_LEVEL` moves to 7.25 to hold the documented quarter-of-entry ratio
- **The bands also TIGHTENED, which is the point of v6 rather than a side effect.** p98 narrowed from 3.7 points wide (38.3 to 42.0) to 2.0 (36.4 to 38.4), and the same holds across symbols: at 1h the share above the buy cutoff ran BTC 18.30% / XRP 10.22% / DOGE 10.89% before and BTC 14.36% / XRP 13.18% / DOGE 13.42% after. One cutoff pair can only mean one thing if the distribution beneath it is the same shape everywhere
- The golden backtest fixture needed no regeneration for this pass: its single trade's `entryScore` of 32.9 is a `buy` under 29/37 as it was under 30/38

### Fixed (tests): two guards that were passing on luck rather than on the property they name
- **`random-entry-benchmark`'s trade-count guard is now one-sided.** It exists to catch the old UNDER-counting bug, but asserted a two-sided 10% bound against a reference of 6 trades, where a single trade of difference is 17%. It held only because the average happened to be 5.9. Separately, and independently of any scorer change, the benchmark **over-generates** once the reference has more than a handful of trades: measured 1.12x at 5 reference trades, 1.29x at 8, 1.32x at 10, and **1.15x on a 1200-bar series with the scorer reverted to main**. That over-count is a pre-existing property of the benchmark, which is the null behind the research `timing` gate, and is worth measuring on its own
- **The benchmark's p-value calibration guard needed a sample.** At 600 bars the reference carries 5 trades and the p-value cannot resolve anything: measured 0.020, 0.055, 0.582, 0.970 and 0.572 across its five seeds, so a **random** reference scored a false positive at the 0.05 level. That is the sample size, not the null, since the research gates apply this benchmark to runs with thousands of trades. Raised to 1200 bars, where the assertion means something
- The golden backtest fixture was regenerated for the third time, values-only and small: the same single trade, the same entry at bar 303, the same `buy` tier and the same 401 equity points, with the signal exit two bars earlier (324 to 322)
- 14 new tests: MACD scale invariance across a four-order-of-magnitude price range, EMA Cross volatility invariance and non-saturation, and taker flow abstaining at a steady level however far from 0.5 while firing on a break that the old fixed band called indifferent
- Stale comments corrected: `score-percentiles.ts` cited cutoffs of 24 and 30, `strategy-families.ts` cited a `STRATEGY_EXIT_LEVEL` of 6. The live values are 30, 38 and 7.5


### Fixed (journal): a P&L the user was shown, then silently discarded
- **`hold` is the default action on the `/signals` form** (`EnhancedJournalForm.tsx:66`), and the chain from there lost data on the most-travelled path. `JournalEntryDetail.tsx:98` computed `isOpenTrade` from the prices alone with no action check, so a `hold` carrying a reference entry price got a "Close Trade" button. `CloseTradeDialog.tsx:42-47` then computed and displayed a P&L preview for any action that is not `sell`. The PATCH route (`[id]/route.ts:75-83`) computes `outcomePnlPercent` **only** for `buy`/`sell`, so the number the user had just been shown was thrown away on submit
- It then became permanent: `analytics/route.ts` matched incomplete trades on `entryPrice != null, outcomePnlPercent: null` with **no `exitPrice` condition**, so the entry counted as incomplete forever and the banner *"N trades without P&L data. Close open trades with an exit price."* could never be cleared by a user who had just done exactly that
- **The root cause was four definitions of "is this a trade" that disagreed.** `POSITION_ACTIONS` and `isPositionAction` now define it once, in `src/types/journal.ts`, and the detail view, the analytics incomplete match, and the `status=open`/`status=closed` list filters all read it. A `hold` or `skip` records a decision *not* to take a position, so it has nothing to close and no return to compute
- The vocabulary lives in `types/journal.ts` rather than beside the Mongoose schema because client components need it: importing it from the model pulls mongoose, and with it `async_hooks` and `child_process`, into the browser bundle. Caught by the build, not by typecheck or tests

### Fixed (journal): analytics stated win rates it had no sample for
- The same page showed **two different win rates for the same data**. `PnlSummaryStrip.tsx:48` guarded on closed trades and rendered a dash; `AnalyticsSummaryCards.tsx:57` did not, and the route returned `winRate: 0` for an empty sample. With production's one entry and no closed trades, `/journal` read `Win Rate -` in the strip and `Win Rate 0.0%` in the Analytics tab. 0% says "you lost", not "no data"
- **Only Kelly had a minimum-sample guard** (`KELLY_MIN_SAMPLE = 20`, with a `reliable` flag). Every other breakdown computed a rate off whatever count existed, so a single closed trade rendered `1 trades - 100%` under a heading like "By Hour (UTC)" -- an hour-of-day edge from one observation. A rate from n=1 carries a standard error of 50 points: not a weak finding, no finding
- `winRate` is now `number | null` across the nine breakdown types, `null` meaning "not enough closed trades to state a rate". New `ANALYTICS_MIN_SAMPLE_FOR_RATE = 5` for breakdowns, deliberately below Kelly's 20 because a descriptive breakdown needs less evidence than a position-sizing suggestion and 20 would blank the surface for any realistic early journal. The summary rate suppresses only at zero, since one closed trade is a real headline result
- Nine consumers now share `analytics/format.ts`, so a new panel cannot reintroduce either bug. `winRateColorClass` returns undefined for an absent rate rather than painting it bearish, which a naive `winRate >= 50 ? bullish : bearish` did to every suppressed row
- Test fixtures that asserted the mapping used samples of 3 and 4, below the new floor. They were **raised while preserving their asserted rates** (3/4 to 6/8 is still 75%) so they keep testing mapping, and a dedicated test now covers suppression at n=1 -- including that `count` is still reported, so the reader sees there is one trade. The route test that asserted `winRate === 0` on an empty dataset now asserts null

### Fixed (marketing): the blog showed four fabricated articles
- `src/app/(marketing)/blog/page.tsx` rendered a hardcoded `ARTICLES` array -- invented titles, invented 2024-2025 dates, invented excerpts and read times -- on a public path. The cards were not clickable, there were no bodies, and no `/blog/[slug]` route existed, so nothing could have been read even if a visitor tried. Replaced with an honest empty state pointing at the documentation
- Its unit test and the `marketing-pages` E2E spec both **asserted the fabricated content** (`'Education'`, `'Strategy'`, `'8 min read'`, `'January 15, 2025'`), which is what kept it in place. Both now assert the empty state, and one test asserts the absence of article metadata so a placeholder cannot quietly return

### Fixed (market): the news feed credited a provider the app stopped using
- `NewsFeed.tsx` rendered "Powered by CryptoPanic" linking to cryptopanic.com. The provider moved to publisher RSS when CryptoPanic's free plan was discontinued; the swap deliberately preserved the function signature "so the NewsFeed component was untouched", and the attribution footer was missed
- The feed list moves to `src/lib/external/news-feeds.ts`, a module with no dependencies so the UI can name its sources without pulling `fast-xml-parser` into the client bundle. `rss-news.ts` re-exports it, so no caller changes. **Both the fetcher and the footer now read the same list**, which is the part that stops it drifting again, and the test iterates that list rather than restating the names

### Fixed (admin): the admin area was unreachable from the UI
- `Sidebar.tsx` computed `isAdmin` as `session?.user?.email && pathname?.startsWith('/admin')`, so the admin nav only rendered once you were **already** inside `/admin` -- the link that takes you there could never appear, and `ADMIN_NAV_ITEMS` was dead code
- Compounding it, `/admin` sat outside the `(dashboard)` route group and had no `layout.tsx`, so `<Sidebar/>` was never mounted there at all: the page rendered with no nav and no header. Moved to `src/app/(dashboard)/admin/`, which leaves the URL unchanged (route groups do not affect paths) and inherits the layout with no duplication
- `session.user.isAdmin` is now derived in the NextAuth session callback by comparing against `ADMIN_EMAIL` **server-side**, so the admin address never reaches the client. It is a navigation hint only: every admin route and page still gates on `requireAdmin`, which remains the authorization boundary. Derived in the session rather than the JWT so revoking admin takes effect on the next session read instead of waiting for a token reissue

### Fixed (e2e): admin-only skips said nothing, and the admin assertion was wrong
- The optimization spec's skips were bare `test.skip()` calls, so the report said a test was skipped without saying why, and the condition was re-derived by hand from `page.url()` in each of 13 tests. **They were correctly reported as skips, not as passes** -- these are the suite's documented admin-env-conditional skips
- The real defect: the only assertion that could run on the admin branch looked for a heading "Optimization Dashboard" while the page renders "Template Optimization". The suite would have failed the first time anyone pointed `ADMIN_EMAIL` at the test user, which is the one configuration that makes these tests worth having
- Skips now carry a reason, the heading matches, and the non-admin path asserts both the redirect and the absence of the admin heading rather than a bare URL check. That spec reads 13 skipped / 3 passed

### Removed (cleanup): modules with no callers
- Deleted with their tests: `src/lib/candle-cache.ts` (superseded by `candle-ingestion` plus `redis.cachedFetch`), `src/lib/seed-templates.ts`, `src/components/journal/ReviewQueue.tsx`, `src/components/backtest/JournalForm.tsx` and `JournalList.tsx` (superseded by `src/components/journal/*`), and `src/components/portfolio/TransactionHistory.tsx`. Each was verified to have no reference outside its own file and test
- `shouldSkipIndicator` removed: zero callers, because `compute-for-style.ts` reads `profile.skipIndicators` directly. Its tests asserted real behaviour that still exists, so they were **retargeted to the config the live path consults** rather than deleted
- `STYLE_OVERRIDES` in `htf.ts` was an always-empty map, so the lookup branch in `getConfirmationInterval` could never return and its `style` parameter had no effect. The map is gone; the parameter stays because callers pass it and a per-style override is a plausible future change
- `/api-reference` removed from the middleware public prefixes: the route does not exist, so the entry made a nonexistent page publicly reachable. Its middleware test asserted the same thing

### Added (llm factor): a readout that cannot be misread
- `scripts/ops/llm-factor-readout.ts` and its pure core `llm-factor-stats.ts`, the companion to `live-outcomes.ts --source llm`. That script answers "what would trading these tiers have returned", which is right for a desk; this one answers "did the panel rank the cross-section", which is the only question a ten-symbol forward-only factor of this size supports
- **It removes market beta.** Over the first resolved window every tier had a positive mean forward return, `sell` included, because the market rose 3.05% over the horizon. A per-tier mean therefore mostly measures what the market did. Removing each bar's cross-sectional mean leaves only the part of a call that was about this symbol versus the others, which is all a simultaneous ten-symbol panel can be credited with
- **It refuses to report significance the sample cannot support.** 1h calls are posted two-hourly against a 24-bar horizon, so consecutive observations share about 22 of those 24 bars. The first read of this record looked like `t = -2.76` on 15 bars; corrected, that is **0.63 independent windows** -- under one observation. `independentWindows`, `inflationFactor` and a `verdict` string exist so the t cannot be quoted without them, and `formatReport` prints the t and its inflation factor on the same line with a test asserting exactly that
- Current reading, prompt v1: **1h demeanedIC -0.3381 over 137 calls in 15 bars, verdict NOT READABLE**; 4h has one bar; 1d has no resolved outcomes (first due 2026-10-09). The inversion is a sign worth watching and nothing more, which is what the tool now says on its own
- The HAC machinery in `scripts/research/ic-stats.ts` is deliberately not reused for the pooled statistic: a Newey-West window at lag h-1 would span the entire sample at the panel's current bar count. Reported honestly instead of dressed up
- Forward-only by construction: it reads settled `SignalOutcome` rows and computes nothing the panel could have seen. Never a backtest, and never an input to prompt selection
- 37 new tests, including that a two-symbol cross-section is refused (demeaning leaves +d/-d, so the IC is +/-1 by construction on noise) and that a record of many observations across few windows still reads NOT READABLE

### Fixed (signals): bump configVersion to 5, so the scorer change is actually separable
- The cutoff change documented `configVersion` as what separates the pre- and post-change outcome series, but did not bump it. `configVersion` is a literal in `compute-engine.ts` and its own comment history shows this is precisely the mechanism for such a change ("v3: calibrated tier cutoffs (24/30)"), so without the bump both series would have been written as `configVersion: 4` and tier-conditioned statistics would have silently pooled two incomparable scorers. Caught by checking the live boundary rather than by a test
- **A short window is contaminated.** The cutoff change deployed at 2026-09-24T14:08Z and this bump followed a few minutes later, so a small number of rows carry `configVersion: 4` while having been scored by the v5 scorer. They are identifiable by `candleTimestamp` and the caveat is recorded in `calibration.ts`

### Fixed (signals): four defects in the live composite scorer, and the cutoffs that rested on them
- **`interpretIndicators` compared a value to itself.** It derived `close` from `raw.ema12.values[length - 1]`, which `computeEMA` defines as `ema12.current`, so `interpretEMACross`'s `aboveEma = close > ema12` was permanently false and every bullish EMA reading scored at 60% of an identical bearish one -- a standing directional bias in the highest-weighted category for three of four styles. `interpretSMATrend`, `interpretIchimoku` and `interpretATR` were likewise handed EMA(fast) where they expect the close. `interpretIndicatorsAtBar` always used the real close, so **the live scorer and the research path disagreed about the same bar**, and the percentile tables in `calibration.ts` described a distribution the live scorer did not produce. `computeAllIndicators` now returns `lastClose` alongside `lastCandleTime`, so no caller threads it through
- **Funding-rate strength fell as the signal got stronger.** The escalation branch computed `|rate| * 10000`, so at -0.0011 it returned 11 while the milder branch just below returned a flat 40 -- a 29-point drop -- and only passed 40 again beyond `|rate| > 0.004`, off the observed distribution. Now scaled to be continuous at the 0.001 threshold and monotonic to the 90 cap
- **Neutral readings voted for zero instead of abstaining.** A neutral signal contributed 0 to a category's numerator while still counting 1 in its denominator. Most indicators sit in their indifference band most of the time, so the score's magnitude was largely a count of how many were undecided. The codebase already had this right twice -- `scoreVolatility` excludes ATR from the mean, `interpretTakerFlow` returns null in its indifferent band -- and generalising that was the fix. A category of only neutral readings now scores 0 for having no opinion, and keeps its weight, which is correct: the data arrived and said nothing
- **OBV's magnitude was a fetch-window artifact.** It normalised the gap from the 20-period average by `|sma20|`, but OBV is a cumulative sum whose origin is bar 0 of whatever window was fetched, so where OBV's level was large the strength read ~0.1 and where the sum straddled zero it pinned at 100. Now measured in bars' worth of average volume, which is origin-independent, full strength at ten bars (a 20-period SMA lags a linear trend by about 9.5 bars, so that is close to the arithmetic ceiling; five clamped realistic trends at 100)
- **The repository's own `no-lookahead.test.ts` caught a bug introduced by that OBV change**, which is the clearest argument for its existence. The new scale is read from the tail of the OBV array, but `interpretIndicatorsAtBar` passes the full series with a bar-local `current`/`sma20`, so it read bars after the one being evaluated. `interpretOBV` now takes an explicit `endIndex`. It is an index and not a pre-sliced array for a second reason found the same way: slicing per bar is O(n^2) across a research run and exhausted a 4 GB heap on the 808k-bar 5m series
- New `interpret-parity.test.ts` asserts the live and per-bar paths agree on every close-dependent trend signal across several seeds. Nothing compared them before, which is why the close defect survived. Verified to fail 5 of 6 against the old derivation
- 12 new tests covering funding monotonicity at and past its threshold, neutral abstention versus genuine disagreement, and OBV origin-independence

### Changed (signals): tier cutoffs raised to 30 and 38
- The first change since they were set, and **not a re-fit**: the scorer the cutoffs were measured against had the four defects above, and correcting them moved the distribution out from under them. Re-measured with `scripts/research/score-percentiles.ts` on the **same** dataset as the 2026-09-21 table (`e84cd66dbe01`, ten symbols, lockbox applied) so the shift is attributable to the scorer and not to a different export. **The pre-fix control reproduced that table exactly**, which is what makes the comparison trustworthy

| interval / style | bars | \|score\| p90 | \|score\| p98 | share > 24 |
| --- | --- | --- | --- | --- |
| 5m scalping | 808,517 | 22.7 -> 28.7 | 30.4 -> 38.8 | 8.1% -> 17.3% |
| 15m day_trading | 320,847 | 23.3 -> 30.3 | 29.2 -> 38.3 | 8.7% -> 21.8% |
| 1h day_trading | 411,013 | 25.4 -> 32.4 | 30.6 -> 39.5 | 13.6% -> 29.5% |
| 4h swing_trading | 152,048 | 25.3 -> 31.6 | 31.8 -> 40.2 | 12.8% -> 26.6% |
| 1d position_trading | 21,687 | 25.3 -> 31.3 | 33.2 -> 42.0 | 12.2% -> 23.3% |

- p90 rose 6 to 7 points and p98 8 to 9 across every interval. Left at 24 and 30, a buy would have fired on 17% to 30% of bars instead of 8% to 14%, and a **strong** buy on 8% to 15% instead of 1.5% to 4% -- "strong" would have meant roughly the top tenth rather than the top fiftieth
- 30 and 38 restore the original selectivity rather than rounding to neat numbers: 30 sits inside the new p90 band (28.7 to 32.4), 38 inside the new p98 band (38.3 to 42.0). Measured shares are **8.5% to 14.8% above 30** against the old 8.1% to 13.6%, and **2.2% to 3.8% above 38** against the old 1.5% to 4.0%. Every interval lands within about a point of where it was
- `STRATEGY_EXIT_LEVEL` moved 6 to 7.5 to hold the documented quarter-of-entry ratio. `DEFAULT_TEMPLATE_THRESHOLDS` derives from these constants, so strategy entry and exit follow
- **This is a discontinuity in the live outcome record.** Signals scored before this deploy used both the old scorer and the old cutoffs; the two changed together, so tier-conditioned statistics must not be pooled across it. `configVersion` on `SignalOutcome` separates the series
- `getTier`'s test table is now expressed relative to the constants instead of restating them, and the `score-percentiles` calibration assertion reads the constants. Both failed only because the numbers were spelled out twice. The golden backtest fixture was regenerated for the cutoff change too: that pass moved exactly one field and no metric, the trade's `entryTier` from `strong_buy` to `buy`, its `entryScore` of 32.9 having cleared the old strong cutoff but not the new one

### Added (ops): every scheduled job now leaves a record, and one call reports them all
- **Eight of the ten cron jobs kept no execution record at all.** `CronRun` is written only by the two optimization routes, `/api/health` checks nothing but `mongoose.connection.readyState`, and the sole other artifact was `/var/log/cron.log` -- truncated nightly, carrying the cron secret, read by nobody. The LLM panel dying unnoticed for three days was one instance of this class, not a one-off
- **The unit of observation is the crontab LINE, not the route.** Four routes are scheduled more than once with different parameters: `sync-candles` three times, `compute-signals` five. Keyed on the route alone, `ingest-snapshots:1d` would die invisibly behind a healthy `ingest-snapshots:1h`, and hourly `compute-signals:position_trading` behind `compute-signals:scalping` firing every minute. `src/lib/cron-jobs.ts` therefore holds 17 entries keyed by route plus the distinguishing parameter
- **`cron-jobs.test.ts` is the anti-drift mechanism.** The app cannot read `docker/crontab.template` at runtime (bind-mounted into the cron container only, absent from the app image), so the table is the source of truth and the test reads the template off disk and asserts a bijection with it: every line has exactly one entry, schedules match verbatim, methods match, and `secondsBetweenRuns` re-derives each declared interval. It supports only the six expression forms actually in use and **throws on anything else**, so a new line in an unrecognised shape fails loudly rather than being silently mis-measured -- a job whose expected interval is wrong is a job that never reports overdue
- **A new `JobHeartbeat` collection rather than a widened `CronRun`.** Three reasons: `/api/admin/cron-runs` queries `CronRun` with no `type` filter and renders results as an optimization job tree, so widening the enum would push the optimization history out of the admin UI on day one; the three existing optimization documents are permanent records while heartbeats at this cadence would need a TTL; and `CronRun` is optimization-shaped (`scheduledAt` required, `jobs[]` carrying tradingStyle/activation fields). Last-state-only, so the two jobs firing every minute upsert one row each instead of writing ~1,440 documents a day, and "is everything running?" is one unfiltered `find()` of 17 rows
- New `withJobRun` wrapper (`src/lib/job-run.ts`), a two-line change per route with the handler body untouched. Three rules, each a real failure mode: a **401 writes nothing** (an unauthenticated probe must not forge a heartbeat, and a wrong secret is not the job failing); any status >= 400 is a failure; and the handler's own response object is returned, never a reconstruction -- a rebuilt response would drop headers while still returning 200 to `wget -qO-`, making the breakage invisible in the cron log. `recordJobRun` never throws, because observability that can 500 a live cron route is worse than none
- **The schema enum does not guard the write path.** Mongoose runs validators on `updateOne` only with `runValidators`, and never on `$setOnInsert`, so an unrecognised key would quietly create a row `/api/health/cron` never reads (it iterates the table, not the collection). `recordJobRun` checks `CRON_JOB_NAMES` explicitly. Found by the model test, not by reading
- New `/api/health/cron`, deliberately **not** an extension of `/api/health`: that route is the container `HEALTHCHECK` target, so a 503 for a late cron job would mark the app container unhealthy and have anything keyed on `service_healthy` restart a working web app because a different container's scheduler is behind. Four states in precedence order -- `never_ran`, `failing`, `overdue`, `healthy` -- and **staleness is measured off `lastSuccessAt`, never `lastRunAt`**: a job failing every minute has a `lastRunAt` seconds old and reads fresh on the naive check, which is exactly the shape of the outage this follows. `cronSecretConfigured` separates "nothing is running" from "nothing can authenticate"
- **The LLM panel is monitored with no write path at all.** It runs from the VPS host crontab and never calls this app, so `crontab.template` cannot see it and the wrapper cannot reach it; its state is derived from the newest `LlmCall.createdAt`. `monthly-optimization` is derived from the newest `CronRun` for a different reason: it is fire-and-forget, returning 200 while the orchestrator runs in the background, so a wrapper would record success at the moment the work *starts*
- `verifyCronSecret` now logs an unset `CRON_SECRET`, matching `verifyLlmPanelSecret`. It was the one misconfiguration that stops everything while saying nothing: the entrypoint substitutes the variable into every crontab line, so unset means every job sends `Bearer ` and 401s forever, indistinguishable from cron not running
- `docker/cron-entrypoint.sh`: **crond is now PID 1 and `tail` the sidecar.** Previously `crond -f &` then `exec tail -f` meant a dead crond left the container `Up`, `restart: unless-stopped` never fired, and every job stopped with every surface still green. Also `tail -F` so it survives the nightly in-place log truncation, a hard failure when `CRON_SECRET` is unset, and a guard on secrets containing `|`, `&` or `\` which the `sed` substitution cannot carry
- Healthcheck on the `cron` service. `pgrep crond` alone only proves the daemon is alive, so it is paired with a `cron.log` mtime check, which also catches a crond running an empty or malformed crontab. Verified against the live container: both `pgrep` and `stat -c` are present via busybox. Plain compose does not restart on unhealthy, so this buys `docker ps` showing `(unhealthy)`; the PID-1 change is what actually restarts it
- 92 new tests across 6 new files

### Fixed (ops): ingest-snapshots reported a clean run during a total upstream outage
- `Promise.allSettled` never rejects and every result was read behind a `status === 'fulfilled'` guard, so nothing could reach the loop's `catch` and `errors` was a hard-coded 0 wearing a variable's clothes. A complete Binance-futures outage returned `ingested: 10, errors: 0`. Rejections are now counted as `fetchErrors`, kept separate from `errors` because an upstream outage and a bug in this loop are different things
- A symbol whose every per-symbol source failed still reached the push, and `mergeSnapshotUpdate` then `$setOnInsert`s `data: {}` -- a row that counts as a snapshot to any coverage query while carrying nothing. Such symbols are now counted as `skipped` and not written. **The emptiness test is over the per-symbol fields, not `Object.keys(data)`**: Fear & Greed is market-wide and written into every symbol's data, so whenever it succeeds `data` is non-empty for a symbol about which nothing was learned

### Added (ops): a count endpoint so the panel's liveness check cannot saturate
- `/api/admin/llm-calls/count` with optional `symbol`, `interval` and `since`. The list route caps at `MAX_LIMIT = 200`, so counting a page of it stopped being a count once an interval passed 200 rows: the VPS wrapper's `stored[...]` line read a flat 200 while 1h actually held 247, a monitor that had silently gone blind in the same way as the thing it was built to catch. Raising the cap only moves the cliff, and shipping every `votes[]` and `rationale` to compute a scalar is the wrong shape
- `llmCallSchema.index({ createdAt: -1 })`, which the existing `{ tradingStyle, createdAt }` compound index cannot serve: neither the newest-call lookup nor a `since` window filters on `tradingStyle`, and an index is only usable from its prefix

### Fixed (signals): the snapshot's news sentiment had no lower time bound
- `/api/cron/ingest-snapshots` passed the merged feed straight to `analyzeNewsSentiment` with no window. The feed is newest-first and was sliced to a flat 20, so once a symbol's recent, relevant stories ran out the sample was padded from the tail, where the publishers keep evergreen explainer and video posts months old. Items whose `pubDate` failed to parse are stored by `parseFeed` as `publishedOn: 0` and sorted to that same tail, so they counted too. The equivalent bug in the LLM packet's headline list was fixed on 2026-09-20; this is the aggregate beside it, left open then and closed now
- **The window is now shared, because the two sit in one packet and disagreed.** `NEWS_WINDOW_MS` (three days) and a pure `filterByWindow(items, fromMs, untilMs)` move into `src/lib/external/rss-news.ts` beside `dedupeAndSort` and `filterByCurrencies`. The helper drops dateless items rather than treating them as very old, since their true age is unknown, and returns survivors newest first so a later cap keeps the newest. `packet.ts` now calls it instead of its own inline filter, and keeps its horizon-derived window with `NEWS_WINDOW_MS` as the floor. Its nine existing tests pass unchanged, which is the evidence the refactor preserved behaviour
- The fetch limit for the sentiment path rises from the default 20 to 100, so the window decides the sample rather than the cap. `count` therefore measures real recent news volume instead of saturating at 20
- A symbol with nothing in the window now stores no `newsSentiment` at all rather than a false neutral. `scoreSentiment` already handles the absent field by redistributing weight, whereas `{count: 0, avgSentiment: 0}` would read as genuine evidence of balanced news
- **Measured impact on the live composite is near zero, smaller than expected when this was scoped.** Across the ten symbols at 1h, nine already reported their true in-window count (ETH 6, SOL 3, XRP/ADA/DOGE/AVAX/LINK 1, BNB/DOT 0) because `filterByCurrencies` runs before the slice and the feeds are only days deep, so the cap bound for BTC alone. The `count >= 3 && |avgSentiment| >= 0.15` gate in `scoreSentiment` currently fires for no symbol at all (nine have `avgSentiment` exactly 0.000, BTC 0.105), so the news sub-signal is inert today either way. The fix makes the window correct by construction rather than by accident of feed depth, which is what would break the moment a publisher exposed an archive feed
- The stored history cannot be recomputed: only the aggregate was ever persisted, never the headlines behind it. Snapshots before this change keep the unbounded values, so the research dataset and the lockbox contain the old feature and the next tier-cutoff measurement must postdate enough post-change snapshots to matter
- 16 new tests: `filterByWindow` over both bounds inclusive, stale items, future-dated items, dateless items, and ordering; and the route analysing only in-window headlines, storing nothing when none are recent, and dropping dateless ones

### Fixed (archive): the perpetual bar series went stale between manual runs
- `perpcandles` (USDT-M perpetual bars, klines and premiumIndex across five intervals) stopped advancing at 2026-08-31 and was 22 days stale, because `/api/cron/ingest-archive` ingests only `metrics` and `bookDepth` and the kline datasets advanced solely when `scripts/ops/ingest-archive.ts` was run by hand. Nothing in the live app reads this collection, so it failed silently
- **The kline datasets are published BOTH daily and monthly, and `ARCHIVE_CADENCE` records the monthly default because that is what bulk history wants.** The monthly file for a month does not exist until that month ends, so a monthly reader is up to a month behind and can never be current. `ArchiveFileSpec` gains an optional `cadence` override resolved through one `cadenceOf` helper, so a caller can ask for the daily form and stay a day behind. `ARCHIVE_CADENCE` itself is unchanged, which leaves the CLI's monthly enumeration untouched: its test for that path passes without edits, and that is the guard
- New `/api/cron/ingest-perp` route, deliberately separate from the metrics route rather than a third pass inside it, because `FuturesMetric` feeds live scoring while this collection has no live consumer, so a research pass failure should not be able to reach a live one. Params `days` (3, cap 7), `to` (default yesterday; present so a window older than the day cap can be reached, which is how the gap was closed), `symbols`, `series` (`klines,premiumIndex`; `markPrice` is opt-in since it holds no documents and the mark price already reaches research through the live snapshot path), and `intervals`. The try/catch sits at the innermost level, one archive file, because there are ten files per symbol-day and a symbol-day-level catch would discard nine good files to report one bad one. The response carries `fetched` alongside `written`, because `written` counts upserted plus modified and a re-run over stored bars reports 0 while nothing is wrong
- The dataset-to-series pairing moved into one `PERP_DATASET_SERIES` literal list shared by the CLI and the route, replacing the CLI's private map. This is the pairing whose drift is expensive: `klines` and `premiumIndex` rows carry the same timestamps, so writing premium rows under series `klines` would overwrite the traded bars with premium values and nothing would notice. The perp writer is likewise extracted to `src/lib/perp-candles.ts` so the two callers cannot shape the same upsert differently
- Daily crontab line at `0 6 * * *` with `days=3`, half an hour after the metrics line, so the two archive-heavy jobs do not overlap and the log boundary between them is clean
- 22 new tests: the cadence override building the daily URL for both kline datasets while leaving the monthly path and the cache key untouched, the pairing, the chunked writer, and the route's window arithmetic, per-series correctness, missing-versus-error handling, and the `to` bounds

### Fixed (archive): the 22-day perpetual bar gap is closed
- The new route was deployed and the gap backfilled by hand in four calls, `to` ending 09-01, 09-08, 09-15 and 09-20 with `days` 1, 7, 7 and 5. Every call returned `missing: 0` and `errors: 0`: 2,000 archive files fetched, 166,000 documents written
- `perpcandles` max timestamp moved from 2026-08-31 to **2026-09-20** for all ten series-interval pairs, and each pair's minimum is still 2022-01-01, so nothing was overwritten. Total 14,127,326 to 14,293,326 documents, matching the ~166k predicted before the run
- The route's own date guard refused `to=2026-09-21` with a 400 during the backfill, because the archive cannot publish a day that has not ended. That is the cap working as designed rather than an incident
- Crontab line confirmed installed after the force-recreate: `0 6 * * * ... /api/cron/ingest-perp?days=3`

### Research (Phase 5, 2026-09-21): banded exposure, six runs, and the track closes
- Six runs on dataset `e84cd66dbe01` with the lockbox applied, ten symbols, 6 windows, `--trials 36`, perp prices for returns, funding and the factor. Table in the header of `scripts/research/exposure-gates.ts`; reports `exposure-<factor>-<interval>-p5c.json`
- **All six fail the gates and the pre-registered falsification criterion fires.** Every confidence interval spans zero, so expectancy fails everywhere; the drop-one-symbol jackknife is 1.0 at 1d and 0.0 at 4h. The 1d runs are flat rather than negative (`positioningZ360` +0.0042%/bar, `positioningZ720` +0.0026%, `positioningZ180` -0.0148%) and never clear the interval; the 4h runs are mildly negative across all three horizons. Per the phase's own criterion, the backtest track closes on this dataset
- **The band was never selected**, which bounds what this shows. `band = 0` won all six 4h windows and five of six at 1d. So the optimizer chose the no-band control nearly everywhere, and the result is better read as "no cell of this grid carries an edge" than as a clean banded-versus-bandless comparison. The reason is recorded too: a per-period Sharpe prefers tidy iid returns, which a continuously rebalanced book has and a wide band does not, so the selection metric is biased against the container the phase was built to test
- **The container had to be rebuilt once, and the rebuild was structural.** First, `targetExposure` was `clamp(-z / zScale)`, effectively binary on a trailing z, so a band could only ever suppress a reposition the signal had genuinely asked for. It is now `-tanh(z / zScale)`. Second, the `zScale` grid was `{1, 2, 3}`, at which the target moves by a median of 0.0624 per bar at 1d and 0.0356 at 4h, above the 0.1 band on a third of bars: every cell traded constantly. Measured on the real column, the grid is now `{3, 6, 12}`. The result did not change between the two grids
- `timing p = 1.000` at 1d is uninformative rather than damning: the gate's two-sided magnitude comparison charges every shuffled draw against an observed mean of nearly zero, so the null always reads "at least as extreme". The 4h values, 0.565 to 0.865, say the same thing legibly
- Turnover fell by roughly 40x between the two grids once the band could act (5,340-bar 4h runs: 186 to 52), so the band mechanism itself works; it simply does not pay. Related: the universe had to be aligned to a shared bar grid first, because SOLUSDT and XRPUSDT are each missing 2022-03-01 and 2022-04-03

### Fixed (research): the exposure target was binary, which made the band inert
- `targetExposure` was `clamp(-z / zScale, -1, +1)`. On a trailing z that is effectively BINARY: `|z|` exceeds 1 on most bars, so almost every reading saturated to +1 or -1 however crowded the book actually was. With a binary target a positive band cannot hedge, it can only lag, because the target only ever moves by the full 2.0 and a band can therefore only suppress a reposition the signal genuinely asked for. It is now `-tanh(z / zScale)`: monotonic, contrarian, continuous, and bounded below 1, so a larger band suppresses small target moves and leaves large ones alone, which is the behaviour the container's hypothesis is actually about.
- **Found by running it, not by reading it.** The first grid run selected `band = 0` in 11 of the 12 windows and the run showed 1.7 to 5.7 bars between rebalances and turnover of 13 to 244 against a held book of 500 to 5,300 bars: a continuously rebalanced book, not a banded one. The optimizer rejecting the band almost everywhere is exactly what a degenerate band knob looks like. The six runs from that grid are discarded as a test of the hypothesis; they are recorded in the session handover as a negative result about the container as built, not as a Phase 5 verdict.
- The grid's `zScale` values keep their meaning under `tanh` (1 saturates quickly, 3 is near linear over the columns' working range), so no grid change was needed. Tests updated to derive their hand-computed costs from the target function rather than from magic numbers, with the saturation bound stated only where it is meaningful: beyond `|z|` of about 9 the gap to 1 is below double precision and `tanh` rounds to exactly 1, which a test pins so the bound is not mistaken for a claim about every magnitude.

### Added (research): the exposure harness
- `scripts/research/exposure-harness.ts` and `exposure-walk-forward.ts`, mirroring `strategy-harness.ts`: same flag parsing and error style, manifest verification, `--expect-manifest-hash`, schema validation before writing, and a `--cell SYMBOL:WINDOW --report` spot check. Grid `band {0, 0.1, 0.25, 0.5}` x `zScale {1, 2, 3}` x `smoothing {none, 8, 32}` = 36 cells, with `band = 0` as the internal control, and `--trials` defaulting to 36 so one phase has one number the way Phase 4c fixed 342
- **Prices, funding and the factor column all come from the perp series.** The returns must be perp because that is where the exposure is held, but building the column there too is a deliberate departure: every earlier phase measured positioning on SPOT closes, so this run evaluates the factor on perp prices and the IC study's `1d h32 ic -0.218` is not a number these reports can be read against. The spot and perp grids are identical on this dataset (every perp bar is a spot bar), and the harness asserts it so a future divergence fails loudly
- **Smoothing and the trim are one fix in two parts.** `simulateExposure` owns `trailingMean`, so a window slice handed a non-zero `smoothing` has no reading at its head and one cell would mean two signals across the split. Pre-smoothing alone is inert, because a trailing mean needs `smoothing` finite readings either way; the run must ALSO trim to `maxSmoothingWarmupBars(factorStart)` rather than to `factorStart`, or the window head is dead for another 31 bars. A test pins both halves, including the control showing the half-fix still fails
- **Purge gap is 0, and that is a decision.** The discrete path needs a gap because the engine carries indicator state across the boundary. This path carries one piece of state, the held weight, and the simulator re-initialises it flat on every call, so nothing crosses. The residual artefact is a cold-start round trip bounded by the symbol count in turnover units, which biases against the run and which a gap could not fix anyway
- In-sample selection is the best per-period Sharpe with a minimum-bars floor, `ceil(minBarsHeldFor(interval) * trainFraction)` (40 at 1d/4h, 120 at 5m). Eligibility also requires at least two finite returns and a non-zero spread, because `perPeriodSharpe` returns 0 rather than NaN for a degenerate series and ranking on that would let a constant-return cell outrank genuinely losing ones. A window where no cell qualifies THROWS rather than skipping, because `ExposureWindowSchema` cannot represent a skip and tolerating one would let the windows gate pass on a single surviving window
- `gross` is the universe size, so peak gross exposure is exactly one unit, which is what the returned `grossExposure` claims. Deriving it from observed exposure was rejected: it would become a function of the cell and rescue under-invested ones, which the simulator's header forbids
- Stress runs as a SECOND pool call, never as the nominal `selected`, or the headline would silently become the post-stress number and the stress gate would be reading the same series as expectancy. Parse-time guards reject a stress configuration that cannot stress anything and a zero study cost
- 46 tests across the two files: the grid order and distinctness, the two-part smoothing fix, the window arithmetic and contiguous bounds, the eligibility traps, the stress separation, the report round-trip, and every refusal the `--cell` spot check makes plus its reproduction of the reported window

### Added (research): the exposure gates and their report schema
- `scripts/research/exposure-gates.ts`. The eight gates, with the controller's thresholds unchanged and the unit of observation re-expressed, because a discrete run's observation is a round trip and an exposure run's is a bar. `sample` becomes a minimum bars HELD plus a minimum share of bars carrying non-zero exposure (a bar count alone is met by a handful of long holds). `expectancy` becomes the net per-period Sharpe CI low bound. `symbols` becomes a drop-one-symbol jackknife, which targets the Phase 4b failure directly where DOGE, LINK and SOL carried the result while BTC and ETH lost, and which a positive-share count cannot distinguish from a symbol that merely happens to be positive. `timing` becomes the circular block shuffle. `stress` stays as it is and becomes the informative gate, since turnover is the entire cost story of a banded exposure. Gates are pushed in `EXPOSURE_GATE_NAMES` order, which is part of the report's contract.
- `maxDrawdownPercent` is now a REAL mark-to-market drawdown. The discrete path's is a synthetic concatenation of ten independent single-symbol runs onto one path (`strategy-gates.ts`), which its own header calls a rough order-dependent proxy; an exposure run holds all ten simultaneously, so its drawdown is a real one. Reported, not gated, per the phase spec.
- `ExposureReportSchema` in `scripts/research/report-schema.ts`, deliberately a separate schema rather than an extension: the two report types share almost no fields, and Zod's plain `z.object` strips unknown keys silently, which already cost this program once when `payoffRatio` would have vanished on parse with no error. A test pins that an undeclared field does not survive a parse.
- 17 more tests, including that the gates come back in contract order, that a concentrated universe fails the jackknife while the pooled number stays positive, that the stress mean is null rather than silently unstressed when the cells carry no multipliers, and that every non-finite statistic is null rather than NaN

### Added (research): the banded target-exposure simulator
- `scripts/research/exposure-sim.ts`. Phase 4b found a factor with a real IC that no discrete-entry rule can turn into an edge, which is the diagnosis `IR = IC * sqrt(breadth)` gives for an autocorrelated factor held in a container of breadth one. This tests the other container: hold the same factor as a banded target exposure across all ten symbols at once.
- A parallel pure research path, deliberately NOT an engine change. The engine holds one position in two nullable slots, `EntryDecision` carries no size, `decideExit` returns a bare boolean, and decisively equity is realized-only (`computeEquityAfterTrade`, called at close sites), so there is no mark-to-market anywhere and a banded exposure is nothing but a mark-to-market path. All eight gates are downstream of `BacktestResult.trades`, so it carries its own gate module and report schema too.
- Weights are fixed through each bar rather than drifted, which is what makes the band's arithmetic checkable by hand, and the signal read at bar t earns the return t -> t+1: an execution lag of one bar, the discipline the factor study settled on 2026-09-20.
- Costs are charged on TURNOVER, `|dw| * (takerFee + slippage)`, from `studyCostConfig`, so both containers are priced from one source. Gross is normalised to a divisor so a cell that leaves the book under-invested is reported as it is rather than scaled up.
- Funding reuses `fundingCrossings` and `fundingPnl`, with one deliberate divergence from `accrueFunding` documented in the header: the rate column here is per bar, so the rate at t IS the rate settling at that bar's boundary, and charging it the bar's whole crossing count would apply one settlement's rate to all three of a 1d bar's settlements. On a flat rate the two agree exactly.
- `bootstrapBlockLength` replaces `max(2, round(cbrt(n)))`. That rule is calibrated on a TRADE count and would be badly undersized on autocorrelated bar returns, which is precisely how a false pass gets manufactured. The block is set from the container's own holding horizon (at least the realised mean bars between rebalances, never below the factor's 32-bar decay horizon) and the realised length is reported on every run.
- `circularBlockShuffle` is the timing gate's null: a block shuffle of the z column preserving its autocorrelation, never a plain shuffle, because a null that destroys the property under test is a strawman that would manufacture a pass. Pinned by a test showing the lag-1 autocorrelation of a strongly autocorrelated series survives within 0.1.
- 28 tests, including the four the phase called for: turnover equals `|dw| * (fee + slippage)` on a hand-computed two-rebalance path, a wider band produces strictly less turnover on the same column, funding on a weight matches `fundingPnl` for the same rate and side, and a constant signal rebalances exactly once and never again

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
