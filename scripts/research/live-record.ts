/**
 * LIVE-RECORD STUDY: were the scheduler's stored signals right, and would following them have paid? Pre-registered.
 *
 * Why: on 2026-10-10, the decision point set in session 07 for the live record, the user asked to research the
 * previously stored signals and whether they had the right outcome, and approved this design ("go ahead, do it
 * until done"). It EVALUATES the deployed scorer; it is not a search for a new rule and adds no trial to the
 * program ledger (2,078).
 *
 * STATUS: LOCKED once committed, before any forward return of the record is read. Only row COUNTS by version,
 * style, interval and status were read to size it (2026-10-10). A change is an amendment recorded below.
 *
 * DATA
 *
 * - `signaloutcomes` in production Mongo, read-only: rows with source 'composite' (or no source, the legacy
 *   default), status 'resolved'. Every scored closed bar of every tier has a row (src/lib/signals/
 *   outcome-resolver.ts): forwardReturnPercent = close-to-close return from the signal bar's close to the close
 *   `horizonBars` later, on SPOT candles; horizons 12 bars (scalping), 24 (day_trading), 30 (swing_trading).
 * - The rows are first exported to a gzipped JSONL file and hashed; the analysis reads only that file, so every
 *   number traces to the export's sha256. Rows with a non-finite forward return are dropped and counted.
 * - Versions: 4, 7 and 8 are analysed (each about a week live); 5 and 6 (hours) are counted only. Cells:
 *   scalping 1m, scalping 5m, day_trading 15m, day_trading 1h, swing_trading 4h. The 1d cells have no resolved
 *   row (20 and 30 day horizons) and are counted only.
 *
 * MEASURES, per (version, cell). BUY = tiers buy and strong_buy, SELL = sell and strong_sell, STRONG =
 * strong_buy and strong_sell (reported separately); fwd = forwardReturnPercent; d = +1 for BUY, -1 for SELL.
 *
 * - BALANCED HIT RATE: BH = (share of BUY rows with fwd > 0 + share of SELL rows with fwd < 0) / 2. Market drift
 *   cancels (an up-move that makes every buy right makes every sell wrong), so 0.5 is no skill. A zero return is
 *   a hit for neither side.
 * - SPREAD: S = mean(fwd | BUY) - mean(fwd | SELL), in percent. Drift cancels here too.
 * - NET: N = mean over BUY and SELL rows of (d x fwd) - cost, cost = defaultCostPercent(interval) from
 *   src/lib/backtest/cost-model.ts (taker fee in and out plus the study slippage budget). N includes the
 *   window's drift, which a trader would really have earned or paid.
 * - Reported beside them: counts per tier, mean fwd and hit rate per tier, the STRONG tiers' BH, S and N, and
 *   the Spearman rank correlation of score with fwd over all rows of the cell (every tier).
 * - Why no period baseline: comparing signals with "all bars of the same period" lets the period's realized
 *   path leak into the baseline (the snipe phase's final review showed a month-matched baseline manufactures
 *   reversal edges on driftless prices); BH and S need no baseline. A committed test runs both on simulated
 *   driftless prices with tiers driven by past returns and requires them to centre at 0.5 and 0.
 *
 * UNCERTAINTY: a moving-block bootstrap over time. The cell's timeline is its sorted distinct candleTimestamps;
 * a block is L consecutive timestamps, L = the cell's horizonBars (one horizon of time, so overlapping
 * outcomes stay inside a block); every symbol's rows at a timestamp move together (cross-symbol correlation
 * kept); blocks are drawn with replacement until the original timeline length is reached; 2,000 resamples,
 * PRNG mulberry32 seed 13; percentile intervals at 95% and 99% (type 7).
 *
 * VERDICT (primary family: version 8 x the five cells; older versions are reported, not judged):
 * - NOT ASSESSABLE if the cell's timeline spans fewer than 5 horizons, or it has fewer than 30 BUY or 30 SELL
 *   rows.
 * - RIGHT if the 99% intervals (Bonferroni over 5 cells: 1 - 0.05 / 5) of BH - 0.5 and of S both lie above 0.
 * - WRONG-WAY if both lie below 0.
 * - PAYS if the 99% interval of N lies above 0.
 * - Otherwise NO DETECTABLE EDGE, with the interval half-widths reported as the smallest edge the sample could
 *   have shown.
 *
 * PAPER DESK: the version-8 paper desk's books (real stops, fees, funding) are read with
 * scripts/ops/paper-desk-outcomes.ts and reported beside the verdict as they are.
 *
 * EXPECTED, stated before any return is read: version 8 has about 8.6 days; 4h will be NOT ASSESSABLE (a 5-day
 * horizon), 15m and 1h most likely NO DETECTABLE EDGE, and if anything is RIGHT it is at 1m or 5m, where the
 * samples are large, and it will not PAY at 0.20% cost.
 */

/** Analysed scorer versions; 5 and 6 ran for hours and are counted only. */
export const LIVE_RECORD_VERSIONS = [4, 7, 8] as const;
export const LIVE_RECORD_PRIMARY_VERSION = 8;

export const LIVE_RECORD_CELLS = [
  { style: 'scalping', interval: '1m' },
  { style: 'scalping', interval: '5m' },
  { style: 'day_trading', interval: '15m' },
  { style: 'day_trading', interval: '1h' },
  { style: 'swing_trading', interval: '4h' },
] as const;

export const LIVE_RECORD_BUY_TIERS = ['buy', 'strong_buy'] as const;
export const LIVE_RECORD_SELL_TIERS = ['sell', 'strong_sell'] as const;
export const LIVE_RECORD_STRONG_TIERS = ['strong_buy', 'strong_sell'] as const;

export const LIVE_RECORD_BOOTSTRAP = { resamples: 2_000, seed: 13 } as const;
/** 1 - 0.05 / 5: Bonferroni over the five primary cells. */
export const LIVE_RECORD_VERDICT_LEVEL = 0.99;
export const LIVE_RECORD_MIN_HORIZONS = 5;
export const LIVE_RECORD_MIN_SIDE_ROWS = 30;

/** Program trial ledger: unchanged, this study evaluates the deployed scorer. */
export const LIVE_RECORD_LEDGER = 2_078;
