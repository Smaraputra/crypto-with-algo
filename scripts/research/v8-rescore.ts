/**
 * V8 HISTORICAL RE-SCORE: would the current scorer's signals have been right over the past year? Pre-registered.
 *
 * Why: the live-record study (scripts/research/live-record.ts) judged version 8 on its 8.6 live days only. On
 * 2026-10-10 the user asked to fill signal generation at least a year back and chose "Both": first this
 * research re-score, then a decision on showing past signals on the chart. Backfilled rows are NEVER written to
 * the live collections (GlobalSignal, SignalOutcome): rows built now for past bars are hindsight rows, and
 * mixing them into the forward record would destroy what makes it valuable. This study writes nothing to
 * production; it runs on the VPS on an exported dataset.
 *
 * STATUS: LOCKED once committed, before any re-scored outcome is computed. It evaluates the deployed scorer
 * (configVersion 8, cutoffs 28/36); nothing is tuned; no trial is added (ledger stays 2,081).
 *
 * WHAT IS RE-SCORED
 *
 * - The scheduler's score for every closed bar of the ten symbols, from the research scoring path
 *   (scripts/research/factors.ts computeFactorMatrix, the `composite` column, the path verified identical to
 *   the live scorer bar for bar on 2026-09-25), with the style the scheduler uses for that interval and tier =
 *   getTier(score) at the v8 cutoffs. Cells: scalping 5m, day_trading 15m, day_trading 1h, swing_trading 4h,
 *   swing_trading 1d, position_trading 1d (1m is retired from scoring).
 * - KNOWN DIFFERENCE from live v8: the news category. Only the news AGGREGATE was ever stored and historical
 *   snapshots do not carry it, so the re-score has no news input and the scorer redistributes its weight, as
 *   live does when news is missing. The study therefore measures "v8 without news". A parity check against
 *   the real live v8 rows (below) reports how far apart the two are.
 * - Outcome: exactly the live resolver's definition (src/lib/signals/outcome-resolver.ts): the close-to-close
 *   return on SPOT candles from the signal bar's close to the close horizonBars later (scalping 12,
 *   day_trading 24, swing_trading 30, position_trading 20); a bar whose horizon runs past the data end, or
 *   whose forward bars are not consecutive, has no outcome.
 *
 * WINDOW: signal bars from 2025-10-01T00:00:00.000Z to 2026-10-09T23:59:59.999Z. Data before 2025-10 is read
 * only as indicator and z-score warmup. The months from 2026-07 were the lockbox; the user's choice covers
 * this year-long evaluation of the deployed scorer, which selects and tunes nothing.
 *
 * MEASURES, UNCERTAINTY AND VERDICT: identical to the live-record study (live-record-stats.ts reused, not
 * reimplemented): balanced hit rate BH, buy-minus-sell spread S, net per signal N after defaultCostPercent,
 * the Spearman score/return correlation; moving-block bootstrap with block = horizonBars, 2,000 resamples,
 * seed 13. Verdict per cell at the 1 - 0.05 / 6 level (Bonferroni over the six cells): RIGHT if the intervals
 * of BH - 0.5 and S both lie above 0, WRONG-WAY if both below, PAYS if N's lies above 0, NOT ASSESSABLE below
 * 5 horizons of timeline or 30 rows on either side, else NO DETECTABLE EDGE.
 *
 * PARITY CHECK (reported, not gating): for every (symbol, interval, style, candleTimestamp) present in both
 * the re-score and the live v8 export of the live-record study ($HOME/live-record-out/live-outcomes.jsonl.gz,
 * sha256 56b3ce50d8a1...), the share with the same tier, the mean and largest |score difference|, and the
 * correlation of the two scores.
 *
 * EXPECTED, stated before any outcome is computed: no cell RIGHT or PAYS; net per signal negative at 5m and
 * 15m (cost-bound), as for every earlier version of the composite; the parity check shows small score
 * differences from the missing news category and most tiers identical.
 */

export const V8_RESCORE_WINDOW = { start: '2025-10-01T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' } as const;

export const V8_RESCORE_CELLS = [
  { style: 'scalping', interval: '5m', horizonBars: 12 },
  { style: 'day_trading', interval: '15m', horizonBars: 24 },
  { style: 'day_trading', interval: '1h', horizonBars: 24 },
  { style: 'swing_trading', interval: '4h', horizonBars: 30 },
  { style: 'swing_trading', interval: '1d', horizonBars: 30 },
  { style: 'position_trading', interval: '1d', horizonBars: 20 },
] as const;

/** 1 - 0.05 / 6: Bonferroni over the six cells. */
export const V8_RESCORE_VERDICT_LEVEL = 1 - 0.05 / 6;
export const V8_RESCORE_CONFIG_VERSION = 8;
export const V8_RESCORE_LEDGER = 2_081;

/*
 * RESULT, 2026-10-10: over the past year the v8 scorer's calls have NO DETECTABLE EDGE in any cell, and at 5m,
 * 15m and 1h they were right LESS often than chance; acting on every intraday call loses about the cost.
 *
 * Inputs, all on the VPS (image crypto-ops:v8-rescore from 663e4a1): dataset
 * a964d87d8f458fed1dccafd15d57fea467c17245817a1254f522b25ffa1e14dd ($HOME/rescore-ds, export-dataset.ts
 * 2025-01-01 to 2026-10-09, 190 files); rows v8-rescore-build.ts -> $HOME/rescore-out/v8-rows.jsonl.gz sha256
 * 2addedf2b2ce8d2e22d04a3f58fb207867f09f9546b25c7ee87e89f7e0967d68 (1,553,180 rows; 1,400 dropped as horizons
 * past the data end); report v8-rescore-run.ts -> $HOME/rescore-out/v8-rescore-report.json sha256
 * 2e19b91553c06f4adcc6f5adfb5d36c9edaaa99075069e99bf5400a040262c74; level 1 - 0.05 / 6; 2,000 block resamples.
 *
 *   cell        rows       buy     sell    BH [99.17%]             S (%)  [99.17%]           N (%) [99.17%]            rho     verdict
 *   5m          1,077,000  45,049  52,057  0.467 [0.455, 0.480]    -0.005 [-0.048, +0.039]   -0.203 [-0.224, -0.180]   -0.022  NO DETECTABLE EDGE
 *   15m         358,800    23,690  22,699  0.459 [0.428, 0.489]    -0.038 [-0.282, +0.199]   -0.180 [-0.303, -0.061]   -0.033  NO DETECTABLE EDGE
 *   1h          89,520     7,874   7,987   0.441 [0.387, 0.495]    -0.156 [-1.115, +0.780]   -0.236 [-0.720, +0.231]   -0.047  NO DETECTABLE EDGE
 *   4h          22,140     803     710     0.471 [0.359, 0.585]    -0.348 [-5.63, +3.89]     -0.341 [-2.73, +1.87]     -0.005  NO DETECTABLE EDGE
 *   1d swing    3,440      39      127     0.447 [0.264, 0.774]    -3.19 [-17.0, +21.7]      -0.73 [-7.19, +6.62]      -0.015  NO DETECTABLE EDGE
 *   1d position 2,280      19      114     0.342 [0.062, 0.594]    -7.18 [-27.4, +21.5]      -5.73 [-14.06, -0.63]     -0.005  NOT ASSESSABLE
 *   (rho = Spearman of score with forward return over every bar; the position cell starts 2026-02 because its
 *   indicators need more history than the export carried, and has fewer than 30 buy rows)
 *
 * PARITY with the real live v8 rows (live-record export 56b3ce50d8a1...): 5m 23,618 matched rows, same tier
 * 100.0%, mean |score difference| 0.01, max 19.50, r 1.000; 15m 7,679 rows, 100.0%, max 1.40; 1h 1,740 rows,
 * 99.9%; 4h 200 rows, identical. The missing news input barely moves the score, so this year of re-scored
 * signals is, to within rounding, what the live scheduler would have produced.
 *
 * Reading:
 * - The balanced hit rate's interval lies wholly below 0.5 at 5m, 15m and 1h: the calls point the wrong way
 *   more often than the right way. The spread's interval spans zero, so the locked WRONG-WAY verdict (both
 *   below) is not reached: wrong more often, by about as much in size as when right.
 * - Net per signal is significantly negative at 5m and 15m (about the 0.20% and 0.16% round-trip cost).
 * - The score is weakly NEGATIVELY ranked with the forward return at every interval (rho -0.005 to -0.047).
 * - Same conclusion as the 8.6-day live record and as every earlier composite version; a year makes it firm.
 * - Expected outcome as stated in the lock: right.
 */
