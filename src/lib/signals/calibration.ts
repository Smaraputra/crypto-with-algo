/**
 * Score calibration shared by live signal tiers and strategy thresholds.
 *
 * Measured 2026-09-16 on production data: default template weights, BTC, ETH,
 * SOL, XRP, and BNB, every bar from 2026-03-04 (snapshot coverage start) to
 * 2026-09-16, with stored funding, open interest, long/short, Fear & Greed, and
 * news, exactly as live signals are scored. Absolute-score percentiles:
 *
 *   style / interval        |score| p90   |score| p98
 *   scalping 1m                 22.6          30.1
 *   scalping 5m                 22.2          29.4
 *   day_trading 15m             23.8          29.8
 *   day_trading 1h              26.1          31.3
 *   swing_trading 4h            24.1          29.1
 *   swing_trading 1d            23.8          27.7
 *   position_trading 1d         25.3          30.5
 *
 * The previous cutoffs (30 buy, 60 strong) sat near or beyond the largest score
 * any style produced, so about 95% of live signals were neutral and no style
 * ever reached a strong tier. Per-style cutoffs would differ from these by 2-3
 * points, less than the variation between market regimes, so one pair is used.
 *
 * Futures and sentiment data compress scores: without them, position_trading's
 * |score| p90 is 54 rather than 25. Backtests over bars with no stored snapshot
 * therefore trade far more often than live would, which is why the snapshot
 * backfill covers every bar of each optimization window.
 *
 * Re-measured 2026-09-19 with scripts/research/score-percentiles.ts on the
 * research dataset (hash 3fdeac9e..., exported 2026-09-18 after the candle
 * refill, ten symbols, one snapshot per bar, lockbox applied so every series
 * ends 2026-06-30, default weights, Ichimoku skipped for scalping as live).
 * The 2026-09-16 table above was taken on bars stored before the finalization
 * fix and on five symbols. 1m is not exported; 15m is day_trading's secondary
 * interval; 1d is scored as position_trading:
 *
 *   interval / style         bars      |score| p90   |score| p98   share > 24   share > 30
 *   5m  scalping           808,517         22.6          30.3        8.0%        2.2%
 *   15m day_trading        320,847         23.0          28.7        8.1%        1.2%
 *   1h  day_trading        411,013         25.1          30.1       12.9%        2.1%
 *   4h  swing_trading      152,048         24.7          31.2       11.6%        2.8%
 *   1d  position_trading    21,687         25.1          31.1       12.0%        2.9%
 *
 * Per-symbol p90 runs from 21.2 (BNB and SOL at 5m) to 27.5 (BNB at 1d) and
 * the share above 24 from 5.6% (XRP at 15m) to 17.8% (BNB at 1d). Every
 * percentile sits within about one point of the 2026-09-16 value at p90 and
 * two at p98, now on years of refilled bars instead of six months of partial
 * ones, so 24 and 30 stand. A cutoff change would break the continuity of the
 * live outcome record for no measured gain.
 *
 * Re-measured again 2026-09-21 on the archive dataset (hash e84cd66dbe01...,
 * ten symbols, lockbox applied so every series ends 2026-06-30). This is the
 * dataset the Phase 3b study and the Phase 4b/4c strategy runs were scored on,
 * and it is not the same export as the 2026-09-19 table above: it carries
 * eleven archive-derived factors, and its snapshot history is the one the
 * archive backfill rebuilt. The point of the re-measurement is that a cutoff
 * validated on one export is not automatically valid on another.
 *
 *   interval / style         bars      |score| p90   |score| p98   share > 24   share > 30
 *   5m  scalping           808,517         22.7          30.4        8.1%        2.2%
 *   15m day_trading        320,847         23.3          29.2        8.7%        1.5%
 *   1h  day_trading        411,013         25.4          30.6       13.6%        2.5%
 *   4h  swing_trading      152,048         25.3          31.8       12.8%        3.4%
 *   1d  position_trading    21,687         25.3          33.2       12.3%        4.1%
 *
 * Every interval reproduces to within half a point at p90, except 1d which
 * moves furthest (p98 31.1 to 33.2, share above 30 from 2.9% to 4.1%) and is
 * the interval the archive backfill changed most. Every share above 24 still
 * lands in the 8% to 14% band the cutoffs were chosen for, and 30 still reads
 * as roughly the top 2% at 5m, 15m and 1h. 24 and 30 stand again.
 *
 * ---
 *
 * CUTOFFS RAISED to 30 and 38 on 2026-09-24, the first change since they were
 * set. Not a re-fit: the scorer they were measured against had four defects,
 * and correcting them moved the distribution out from under them.
 *
 * What changed in the scorer (same commit): `interpretIndicators` derived
 * `close` from `ema12.values[last]`, which is `ema12.current` under another
 * name, so the moving-average comparisons read a value against itself;
 * funding-rate strength FELL as |rate| rose past its own escalation threshold;
 * neutral readings counted in each category's denominator, so the score's
 * magnitude was largely a count of how many indicators sat in their
 * indifference bands; and OBV's magnitude was normalised by the level of a
 * cumulative sum whose origin moved with the fetch window.
 *
 * Re-measured on the SAME dataset as the 2026-09-21 table above (e84cd66dbe01,
 * ten symbols, lockbox applied) so the shift is attributable to the scorer and
 * not to a different export. The pre-fix control reproduced that table exactly,
 * which is what makes the comparison trustworthy.
 *
 *   interval / style         bars      |score| p90      |score| p98      share > cutoff
 *                                    before -> after  before -> after   old 24 -> new 30
 *   5m  scalping           808,517    22.7 -> 28.7     30.4 -> 38.8      8.1% -> 8.5%
 *   15m day_trading        320,847    23.3 -> 30.3     29.2 -> 38.3      8.7% -> 10.5%
 *   1h  day_trading        411,013    25.4 -> 32.4     30.6 -> 39.5     13.6% -> 14.8%
 *   4h  swing_trading      152,048    25.3 -> 31.6     31.8 -> 40.2     12.8% -> 12.7%
 *   1d  position_trading    21,687    25.3 -> 31.3     33.2 -> 42.0     12.2% -> 11.8%
 *
 * p90 rose 6 to 7 points and p98 8 to 9 across every interval. Left at 24 and
 * 30, a buy would have fired on 17% to 30% of bars instead of 8% to 14%, and a
 * STRONG buy on 8% to 15% instead of 1.5% to 4% -- "strong" would have meant
 * roughly the top tenth rather than the top fiftieth.
 *
 * 30 and 38 restore the original selectivity rather than rounding to neat
 * numbers: 30 sits inside the new p90 band (28.7 to 32.4) and 38 inside the new
 * p98 band (38.3 to 42.0). Measured shares at the new cutoffs are 8.5% to 14.8%
 * above 30 against the old 8.1% to 13.6%, and 2.2% to 3.8% above 38 against the
 * old 1.5% to 4.0%. Every interval lands within about a point of where it was.
 *
 * THIS IS A DISCONTINUITY IN THE LIVE OUTCOME RECORD. Signals scored before
 * this deploy used both the old scorer and the old cutoffs; the two changed
 * together, so tier-conditioned statistics must not be pooled across it.
 * `GlobalSignal.configVersion` was bumped 4 to 5 for exactly this purpose (the
 * same mechanism v3 used when these cutoffs were first calibrated), and
 * `SignalOutcome` carries it through, so filter on it rather than on a date.
 *
 * ONE CAVEAT ON THAT BOUNDARY, measured rather than estimated. The scorer and
 * cutoff deploy completed at 2026-09-24T14:10:50Z and the version bump at
 * 14:26:15Z, so bars in between were scored by v5 while still being written as
 * `configVersion: 4`. That is exactly **103 GlobalSignal rows** with
 * `candleTimestamp` in [14:10:50Z, 14:26:15Z). They carry the new scorer's
 * signature -- the strong-tier share over that window is 1.0% against 3.3% for
 * the three hours of genuine v4 before it, which is the raised strong cutoff
 * taking effect -- so exclude them from any comparison that leans on the
 * version alone:
 *
 *   { configVersion: 4, candleTimestamp: { $lt: 1790259050000 } }   // genuine v4
 *
 * There is no equivalent gap for SignalOutcome beyond the ones these rows seed.
 *
 * ---
 *
 * RE-MEASURED FOR configVersion 6, 2026-09-25. CUTOFFS ARE NOW 29 AND 37.
 *
 * v6 made three indicator strength scales scale-free (`interpretMACD`,
 * `interpretEMACross`, `interpretTakerFlow`), which moves the distribution, so
 * these had to be re-derived. Measured on export `e705b347`, a fresh export of
 * production taken 2026-09-25, with the lockbox applied.
 *
 * WHY THAT EXPORT IS COMPARABLE WITH THE 30/38 TABLE ABOVE, which was measured
 * on `e84cd66dbe01`: running the UNCHANGED v5 scorer over it reproduces that
 * table exactly, at every interval, in bar count as well as percentile. The
 * post-2026-07-01 rows the newer export also carries are dropped by the
 * lockbox, so for measurement purposes the two exports are the same data. That
 * control is what makes the comparison below attributable to the scorer rather
 * than to the export.
 *
 *   interval / style         bars      |score| p90   |score| p98
 *   5m  scalping           808,517     28.7 -> 27.3   38.8 -> 36.6
 *   15m day_trading        320,847     30.3 -> 30.3   38.3 -> 37.3
 *   1h  day_trading        411,013     32.4 -> 32.2   39.5 -> 38.4
 *   4h  swing_trading      152,048     31.6 -> 28.9   40.2 -> 36.4
 *   1d  position_trading    21,687     31.3 -> 26.3   42.0 -> 36.7
 *
 * The v6 bands are p90 26.3 to 32.2 and p98 36.4 to 38.4, means 29.0 and 37.1.
 * 29 and 37 are those means rounded, both inside their band, which is the same
 * rule 30 and 38 were set by. They restore the selectivity these constants
 * document -- the most decisive tenth and the top fiftieth -- which 30 and 38
 * no longer marked once the distribution moved: at 30 the share ran 6.3% to
 * 14.6% and at 38 it ran 1.3% to 2.3%, so the strong tier had drifted to
 * roughly the top sixty-fifth.
 *
 * NOTE THE TIGHTENING, which is the point of v6 rather than a side effect. The
 * p98 band narrowed from 3.7 points wide (38.3 to 42.0) to 2.0 (36.4 to 38.4),
 * and the same holds across SYMBOLS, which is what the fix was for: at 1h the
 * share above the buy cutoff ran BTC 18.30% / XRP 10.22% / DOGE 10.89% before
 * and BTC 14.36% / XRP 13.18% / DOGE 13.42% after, with the BTC-to-XRP
 * strong-tier ratio falling from 2.47x to 1.04x. One cutoff pair can only mean
 * one thing if the distribution beneath it is the same shape everywhere.
 *
 * Re-measure with `scripts/research/score-percentiles.ts` on a fresh export
 * whenever the scorer changes, and always run the unchanged scorer over the new
 * export first as a control. Never tune these on PnL.
 *
 * ---
 *
 * RE-MEASURED AFTER configVersion 7, 2026-09-25. 29 AND 37 STAND, AND ONE HALF
 * OF THE CHANGE IS STRUCTURALLY UNMEASURABLE HERE.
 *
 * Two code changes landed together: the news lexicon repair (v7) and a causal
 * snapshot join (`buildSnapshotSeries` now holds a snapshot back until its
 * whole capture window has closed). Measured on a fresh export `f470933e`
 * taken from production after the deploy, with the lockbox applied, as three
 * runs over the SAME export so each delta is attributable:
 *
 *   A  v6 scorer, loose join      the control
 *   B  v6 scorer, causal join     isolates the join
 *   C  v7 scorer, causal join     adds the news repair
 *
 *   interval / style       bars      p90 A/B/C        p98 A/B/C
 *   5m  scalping        808,517   27.3 27.3 27.3   36.6 36.7 36.7
 *   15m day_trading     320,847   30.3 30.4 30.4   37.3 37.4 37.4
 *   1h  day_trading     411,013   32.2 32.2 32.2   38.4 38.4 38.4
 *   4h  swing_trading   152,048   28.9 28.9 28.9   36.4 36.3 36.3
 *   1d  position_trading 21,687   26.3 26.5 26.5   36.7 36.7 36.7
 *
 * THE CONTROL REPRODUCES THE RECORDED v6 TABLE EXACTLY, percentile for
 * percentile and bar count for bar count, so `f470933e` is measurement-
 * equivalent to `e705b347` and every difference below is code.
 *
 * THE JOIN MOVES NOTHING THAT MATTERS: at most 0.2 points at any percentile,
 * p90 mean 29.0 -> 29.1 and p98 mean 37.1 -> 37.1. The composite barely notices
 * a correction that was 45 minutes of lookahead on one category's inputs, which
 * is itself the useful reading: funding and sentiment are a small share of the
 * score, and the lookahead mattered to the RESEARCH columns rather than to the
 * live tiering.
 *
 * C IS BIT-IDENTICAL TO B ON EVERY METRIC, and that is not evidence the news
 * repair does nothing. `score-percentiles` scores history from the STORED
 * `data.newsSentiment` aggregate on each HistoricalSnapshot, which was written
 * at ingest time by the old code. Only `{count, avgSentiment}` is persisted,
 * never the article text, so no historical re-run can re-derive it. The
 * historical measurement is BLIND to v7 by construction, and any future
 * re-measurement will be too until enough post-2026-09-25 snapshots exist to
 * measure on their own.
 *
 * What was measured instead, since it was the only thing measurable: both
 * builds were run against the same live feed inside one 5-minute Redis cache
 * window, so they saw an identical article set. Across the ten signal symbols,
 * BTC moved 0.0500 -> 0.0475, SOL 0.2000 -> 0.2400, the other eight were
 * unchanged or had no articles, no symbol's News signal changed gate state, and
 * no near-duplicate cluster existed in that window to collapse. A single
 * snapshot of a feed, so it bounds the typical effect rather than the worst
 * case: the audit's measured cases (the `ban`/bank false positive, the
 * four-outlet press release) simply were not in that window.
 *
 * So 29 and 37 are carried forward MEASURED, not assumed, for everything a
 * historical export can see. */

/** |score| above this is a buy or sell: roughly the most decisive 10% of bars. */
export const TIER_BUY_CUTOFF = 29;

/** |score| above this is a strong buy or strong sell: roughly the top 2%. */
export const TIER_STRONG_CUTOFF = 37;

/**
 * A position opened on a buy signal closes once the score falls back to a
 * quarter of the entry level, the same exit-to-entry ratio the previous
 * defaults used. Moves with TIER_BUY_CUTOFF to hold that ratio: 24 -> 30 -> 29.
 */
export const STRATEGY_EXIT_LEVEL = 7.25;
