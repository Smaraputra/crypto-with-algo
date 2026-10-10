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

/*
 * RESULT, 2026-10-10: the stored signals were NOT right more often than chance. Version 8 (live): NO DETECTABLE
 * EDGE at 1m, 5m, 15m and 1h, 4h NOT ASSESSABLE; following every signal LOSES about the cost at 1m and 5m.
 * Version 7 was significantly WRONG-WAY at 5m and 15m (reported, not judged).
 *
 * Inputs, all on the VPS (crypto-ops:live-record built from 9b9405a): export by scripts/ops/
 * export-live-outcomes.ts at cutoff 2026-10-10T09:51:51Z, 280,942 resolved composite rows (v4 87,447,
 * v5 8,964, v6 660, v7 78,518, v8 105,353), $HOME/live-record-out/live-outcomes.jsonl.gz sha256
 * 56b3ce50d8a1ca106fbf59afd5feec7cf1e833585401872876bb134f1dd3c08e; report by live-record-run.ts --export <it>
 * --expect-sha256 <it> --cutoff-ms 1791625911659, $HOME/live-record-out/live-record-report.json sha256
 * 3d4fa3e369195a610bc8705e93ea18d237c7f380e432187474f235530e3283ba (2,000 block resamples, seed 13).
 *
 * BH = balanced hit rate, S = buy minus sell forward return (%), N = net directional return per signal after
 * cost (%), intervals at 99%:
 *   ver cell    rows    buy   sell  BH [99%]               S [99%]                  N [99%]                    verdict
 *   8   1m      70,465  3,266 2,724 0.481 [0.446, 0.512]   +0.013 [-0.027, +0.054]  -0.194 [-0.214, -0.173]    NO DETECTABLE EDGE
 *   8   5m      24,778    951 1,240 0.456 [0.385, 0.527]   +0.002 [-0.184, +0.197]  -0.196 [-0.292, -0.092]    NO DETECTABLE EDGE
 *   8   15m      8,060    400   701 0.457 [0.325, 0.589]   +0.061 [-0.804, +1.081]  -0.086 [-0.598, +0.522]    NO DETECTABLE EDGE
 *   8   1h       1,830     96   284 0.430 [0.223, 0.669]   -0.082 [-2.659, +2.662]  +0.013 [-1.174, +2.076]    NO DETECTABLE EDGE
 *   8   4h         220     13     0 n/a                    n/a                      n/a                        NOT ASSESSABLE
 *   7   1m      52,161  1,235 2,830 0.440 [0.398, 0.483]   -0.034 [-0.099, +0.034]  -0.219 [-0.250, -0.185]
 *   7   5m      18,348    443   838 0.383 [0.309, 0.463]   -0.361 [-0.678, -0.084]  -0.367 [-0.518, -0.232]    (wrong-way)
 *   7   15m      6,099     77   550 0.298 [0.163, 0.452]   -1.542 [-3.154, -0.157]  -0.758 [-1.177, -0.403]    (wrong-way)
 *   7   1h       1,530     28   135 0.408 [0.077, 0.537]   -0.538 [-5.017, +0.505]  -0.879 [-1.450, +0.071]
 *   4   1m      58,228  2,866 2,629 0.476 [0.443, 0.511]   -0.019 [-0.087, +0.043]  -0.209 [-0.243, -0.178]
 *   4   5m      20,309  1,055   715 0.561 [0.467, 0.645]   +0.209 [-0.162, +0.548]  -0.081 [-0.253, +0.080]
 *   (v4 15m: 19 sell rows; v4 1h: no sell row; 4h cells too thin; v7 4h: no directional row)
 *
 * Reading:
 * - Every v8 balanced hit rate is below 0.5 as a point estimate (0.43 to 0.48), none significantly. The live
 *   scorer's buy and sell calls did not beat a coin flip in its first 8.6 days, and at 1m and 5m, where the
 *   samples are large enough to be sure, acting on every call lost about the round-trip cost (0.19% to 0.20%
 *   per signal; the intervals exclude zero).
 * - v7's calls at 5m and 15m went the wrong way more often than chance (balanced hit 0.38 and 0.30, spreads
 *   below zero at 99%) during its one week, 2026-09-25 to 10-01; a single week is one regime, so this says the
 *   signals were wrong then, not that the inverse is an edge.
 * - The v8 calls lean to sells (1h 96 buys against 284 sells; 4h 13 buys and no sell).
 * - Expected outcome as stated in the lock: right (4h not assessable, no edge at 15m and 1h, losing net at
 *   1m/5m); the hoped-for RIGHT at 1m/5m did not appear.
 *
 * PAPER DESK (v8 books, scripts/ops/paper-desk-outcomes.ts --config-version 8, output
 * $HOME/live-record-out/paper-desk-v8.txt sha256 2cdb99e79d441ead3dd4af8e7ae8e4e9bb95b5e46f87eb60a2b9e2a888346671):
 *   5m: 568 trades, expectancy -0.171% per trade, 95% CI [-0.226%, -0.115%], equity 10,000 -> 8,443.41
 *       (the desk's own read rule: FUTILITY, the edge read is closed)
 *   15m: 191 trades, -0.096% [-0.327%, +0.158%], equity 9,829.91
 *   1h: 67 trades, -0.157% [-0.951%, +0.756%], equity 9,956.06
 *   4h: 7 trades, -1.05%; 1d swing 2 and position 1 trades, all losing.
 */
