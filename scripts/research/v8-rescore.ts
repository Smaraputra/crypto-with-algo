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
