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
 * ONE CAVEAT ON THAT BOUNDARY: the cutoff change deployed at 2026-09-24T14:08Z
 * and the version bump followed it by a few minutes, so a small number of rows
 * carry `configVersion: 4` while having been scored by the v5 scorer. Bars in
 * that window are identifiable by `candleTimestamp` and are worth excluding
 * from any comparison that leans on the version alone.
 */

/** |score| above this is a buy or sell: roughly the most decisive 10% of bars. */
export const TIER_BUY_CUTOFF = 30;

/** |score| above this is a strong buy or strong sell: roughly the top 2%. */
export const TIER_STRONG_CUTOFF = 38;

/**
 * A position opened on a buy signal closes once the score falls back to a
 * quarter of the entry level, the same exit-to-entry ratio the previous
 * defaults used. Moved with TIER_BUY_CUTOFF (24 -> 30) to hold that ratio.
 */
export const STRATEGY_EXIT_LEVEL = 7.5;
