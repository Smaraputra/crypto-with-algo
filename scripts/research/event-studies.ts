/**
 * EVENT STUDIES PHASE: forced deleveraging, funding extremes and volume shocks, pre-registered, one run.
 *
 * Why: the program measured open-interest change, OI-price divergence, funding and taker flow as LINEAR
 * factors (information coefficients over every bar) and none survived at 1h to 1d. A linear IC averages a
 * rare event over thousands of ordinary bars, so an effect that exists only around liquidation cascades,
 * funding extremes or volume shocks would be invisible there. This phase measures those events directly.
 * The literature gathered on 2026-10-07 expects small effects: post-liquidation continuation of about 1 bp
 * (Amberdata 2023, Binance ETHUSDT), jumps that persist rather than reverse (Scaillet, Treccani, Trevisan),
 * and toxicity measures that predict volatility, not direction (Easley, O'Hara, Yang, Zhang 2024).
 *
 * Plan: ~/.claude/plans/next-data-tracks-2026-10-07.md (track T2), approved by the user on 2026-10-08.
 *
 * STATUS: LOCKED once committed, before any event is computed. Nothing below may change; a change means a
 * new pre-registration and new trials. Choices the text leaves open are recorded as implementation notes at
 * build time, before any run.
 *
 * TRIALS AND LEDGER
 *
 * - Nine trials: three events (E1, E2, E3) x three horizons (1h, 4h, 24h), each a two-sided test, never
 *   extended. Program ledger: 1,732 after the broad flow phase; this phase adds 9, for 1,741.
 * - A cell that passes is provisional: it becomes the input of a rule family with its own pre-registration
 *   (and its own lockbox read). A phase with no passing cell closes these three event definitions.
 *
 * DATA
 *
 * - The ten symbols BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK (USDT-M perpetual), from production
 *   Mongo, exported to a fresh directory with every file hashed: 1h perp klines (open, close, base volume),
 *   5m futures metrics (open interest in contracts), and the archive's funding settlements.
 * - Hourly open interest is the last 5m value inside the hour; an hour without one has no OI change.
 * - Sample: events from 2022-07-01 (after a 180-day warmup from the 2022-01-01 start of the 1h perp series)
 *   to 2026-06-30. Lockbox: nothing from 2026-07-01 onward is read; a horizon that would reach past
 *   2026-06-30 drops its event.
 * - A missing or zero-volume hour is not an event hour and breaks no threshold; a horizon that crosses a
 *   missing hour drops its event.
 *
 * EVENTS (per symbol, decided at the close of hour h; every threshold is a percentile over that symbol's
 * non-missing hours among h - 4,320 to h - 1, the trailing 180 days, so nothing at or after h sets it; with
 * fewer than 2,000 non-missing hours in that window there is no event at h)
 *
 * - E1, forced deleveraging: the hour's log change in open interest is at or below its trailing 2nd percentile
 *   AND the hour's |log return| is at or above its trailing 98th percentile. Direction d = sign(return of h).
 * - E2, funding extreme: at a settlement, the rate is at or above the trailing 99th percentile of that symbol's
 *   settlement rates over the previous 180 days (crowded longs, d = +1) or at or below the 1st percentile
 *   (crowded shorts, d = -1), at least 300 earlier settlements in that window. The event hour h is the hour
 *   whose close is the settlement; because acting at the settlement instant assumes no latency, E2 enters one
 *   hour later, at the open of hour h + 2, and its horizon counts from there.
 * - E3, volume shock: the hour's base volume is at or above its trailing 99th percentile. Direction
 *   d = sign(return of h).
 * - De-overlap, chronological and greedy, per horizon H: walking forward in time, an event of the same type on
 *   the same symbol whose entry falls inside a kept event's forward window is dropped, so no two kept events
 *   of a cell share a forward window on one symbol.
 *
 * MEASUREMENT (per cell: event x horizon H in {1, 4, 24})
 *
 * - Forward return: log(close of hour h + H / open of hour h + 1), the trade a taker could take at the next
 *   open, signed by d (positive = the event direction continued; for E2 positive = price moved the way the
 *   crowd was positioned).
 * - Gross statistic: the mean signed forward return over kept events, with a 95% CI from a circular block
 *   bootstrap over UTC days (blocks of 7 consecutive days; every event entering on a resampled day is drawn,
 *   across symbols; 2,000 draws, seed 42), and a two-sided p-value from the same draws recentred at zero:
 *   p = (1 + draws with |bootstrap mean - observed mean| >= |observed mean|) / 2,001.
 * - Net: with s fixed BEFORE any data by the event's predicted direction (E1 s = +1, continuation; E2 s = -1,
 *   against the crowd; E3 s = -1, reversal), each event's net return = s x (its signed forward return) - 0.16% (taker 0.05% both legs plus 3 bps slippage
 *   both legs, the study's 1h cost) - the funding that position pays over the hold (archive settlements in
 *   (open of h + 1, close of h + H], signed by the position's side). The net statistic is the mean of those,
 *   with the same day-clustered bootstrap.
 *
 * GATES PER CELL (all must pass)
 *
 * 1. Significance: Benjamini-Yekutieli at a false discovery rate of 0.10 across the nine two-sided p-values
 *    (valid under any dependence; the nine cells share events across horizons).
 * 2. Pays: the net mean's bootstrap 95% CI low > 0.
 * 3. Breadth: the gross mean has the sign of s in at least 6 of the 10 symbols (symbols with fewer than 10
 *    kept events count as disagreeing).
 * 4. Time: the gross mean has the sign of s in at least 3 of the 4 years 2022H2 + 2023, 2024, 2025, 2026H1
 *    (2022H2 and 2023 pooled as one period).
 * 5. Sample: at least 100 kept events over at least 60 distinct days.
 * Reported, not gated, per cell: counts by symbol and year, the gross mean at 2x cost, median signed return,
 * hit rate, the share of events inside the largest 10 event days, and the result with E1's thresholds at
 * 1st and 99th percentiles instead of 2nd and 98th.
 *
 * VOLATILITY (reported, not gated; the evidence for a market-stress read in the product)
 *
 * - For every kept event at H = 24: realised volatility over the next 24 hours (sum of squared hourly log
 *   returns) divided by its trailing 30-day hourly mean scaled to 24 hours; its median and 95% CI per event.
 * - A stress flag = any E1 or E3 event on any of the ten symbols in the last 24 hours; its AUC for the next
 *   24 hours' BTCUSDT realised volatility landing in its trailing 180-day top quintile, fitted on nothing (the
 *   flag has no parameters), measured over 2024-07-01 to 2026-06-30 as balanced accuracy (the mean of its hit
 *   rate on top-quintile days and its true-negative rate on the rest; a binary flag has no richer AUC). The
 *   product read ships only if that balanced accuracy is at least 0.60 and the volatility ratio after E1 or
 *   E3 is above 1 with a CI excluding 1.
 *
 * PREDICTIONS (written before any event is computed)
 *
 * - E1: small continuation at 1h (gross +0.02% to +0.10%), nothing at 4h and 24h; no cell pays.
 * - E2: small reversal (price moves against the crowd) at 24h, gross under 0.3%; does not pay or fails time.
 * - E3: reversal at 1h from the bounce, small; no cell pays.
 * - Volatility: ratio after E1 and E3 between 1.3 and 2.0; stress-flag balanced accuracy 0.58 to 0.66.
 * - Expected verdict: no directional cell passes; the volatility read passes its product criterion.
 *
 * Reviewed adversarially by agy on 2026-10-08 before the lock: the net gate's direction is now fixed in advance
 * (it was the sign of the same sample's gross mean, a bias toward passing), the bootstrap uses 7-day blocks,
 * the p-value is recentred, de-overlap and percentile windows are mechanical, multiple testing is
 * Benjamini-Yekutieli, E2 enters an hour after the settlement, and the stress flag is judged on balanced
 * accuracy.
 */
export {};
