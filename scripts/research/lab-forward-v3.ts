/**
 * FORWARD SIGNAL LAB, lab-v3: Round 2 single hypothesis, judged only on bars recorded after the live job starts.
 * Pre-registered.
 *
 * WHY: next-version Round 2 evaluated literature anomalies and momentum/carry signals across the survivorship-free
 * top-30 Binance USDT-M perpetual contracts (March 2021 to June 2026), incorporating 7 bps/side transaction costs and
 * perpetual funding payments (nv2-preview.ts, commit 55ded39). Only weekly staggered funding level carry (F1)
 * generated a positive net Sharpe (+0.82), with +0.038%/day gross driven by funding collection (+0.030%/day funding,
 * +0.020%/day price move, -0.012%/day cost). In the null simulation (200 random-ranking runs), 0 crossed.
 *
 * ERROR BUDGET: Round 2 allocates its entire error budget (alpha = 0.005) to this single hypothesis (F1-1d), giving an
 * e-process crossing threshold of 1 / 0.005 = 200.
 *
 * POWER: At the historical annual Sharpe of +0.82, a 24-month forward test has only an approximate 5% chance of
 * crossing threshold 200. By the program stop rule, if F1-1d does not cross, this is the final research round.
 *
 * UNIVERSE: 30 perpetual contracts frozen at 2026-10-20 by median quote volume with sha256 hash
 * e1035a116d5432568c798dfb5213e0e06ba90d6c899fcef607521db2fb957dfc.
 *
 * HYPOTHESIS F1-1d:
 * - At each 00:00 UTC daily close T:
 *   - Fetch trailing funding settlements in (T - 7d, T] for each of the 30 coins.
 *   - Coins with >= 18 settlements receive score = -sum(rates). Coins with < 18 are skipped ('funding_incomplete').
 *   - Target book: dollar-neutral, gross-1 rank-weighted weights over scored coins (minimum 8 coins).
 *   - Active book: 7-day staggered book = equal 1/7 average of target books from T, T-1d, ..., T-6d.
 *   - Return evaluated on perp prices over [T + 10m, T + 10m + 1d] plus net settled funding minus 7 bps/side turnover.
 *   - Stepped via e-process toward threshold 200.
 *
 * STATUS: LOCKED before any live lab-v3 bar exists.
 */

import {
  LAB_HYPOTHESES_V3,
  LAB_V3_THRESHOLD,
  LAB_V3_UNIVERSE,
  LAB_V3_UNIVERSE_SHA256,
  LAB_VERSION_V3,
} from '@/lib/signals/lab/candidates';

export const LAB_FORWARD_V3_LOCK = {
  version: 'lab-v3',
  hypotheses: [
    { id: 'F1-1d', candidate: 'F1', timeframe: '1d', metric: 'book', scale: 0.1 },
  ],
  slots: 1,
  alphaPerSlot: 0.005,
  threshold: 200,
  delayMs: 600_000,
  universe: LAB_V3_UNIVERSE,
  universeSha256: LAB_V3_UNIVERSE_SHA256,
  f1: {
    staggerDays: 7,
    minSettlements7d: 18,
    minScoredCoins: 8,
    costPerSide: 0.0007,
  },
  maxMonths: 24,
} as const;

export const LOCKED_CODE = {
  LAB_HYPOTHESES_V3,
  LAB_V3_THRESHOLD,
  LAB_VERSION_V3,
  LAB_V3_UNIVERSE,
  LAB_V3_UNIVERSE_SHA256,
};
