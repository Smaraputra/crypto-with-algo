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
 */

/** |score| above this is a buy or sell: roughly the most decisive 10% of bars. */
export const TIER_BUY_CUTOFF = 24;

/** |score| above this is a strong buy or strong sell: roughly the top 2%. */
export const TIER_STRONG_CUTOFF = 30;

/**
 * A position opened on a buy signal closes once the score falls back to a
 * quarter of the entry level, the same exit-to-entry ratio the previous
 * defaults used.
 */
export const STRATEGY_EXIT_LEVEL = 6;
