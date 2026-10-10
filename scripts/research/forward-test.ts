/**
 * FORWARD TEST of the program's two near-misses on never-touched data. Pre-registered.
 *
 * Why: the user asked on 2026-10-10 to forward-test the two near-misses on the VPS, and chose to OPEN THE
 * LOCKBOX for these two frozen rules only ("Open lockbox, then continue"): the never-read 2026-07-01 to
 * 2026-10-09 window is the first forward window, then the rules are re-read monthly on new data.
 *
 * STATUS: LOCKED once committed, before any lockbox row is exported or read. The rules below are FROZEN exactly
 * as found; nothing is re-tuned. A change is an amendment recorded below.
 *
 * THE FROZEN RULES (three cells, one family)
 *
 * - A1, RSI oversold, LONG (scripts/research/snipe.ts, confirmed 2026-10-10): 5m USDT-M perp candles of the ten
 *   symbols, the factor column raw.rsi as factors.ts builds it at 5m (the scalping style's RSI(7)) on PERP
 *   candles, bottom 10% tail (value <= the 10th percentile of the trailing 90 days, recomputed at each UTC
 *   month start), entry at the next bar's open, target and stop 1 x Wilder ATR(14) through bar t-1, first touch
 *   on 5m candles, 1 hour limit, ambiguous and timeouts excluded from the win rate, one position per symbol.
 * - A2, RSI overbought, SHORT: the same with the top 10% tail (>= the 90th percentile), short direction.
 * - B, small-trade taker imbalance, NEGATIVE IC (scripts/research/qh-flow.ts, strongest cell, not passed):
 *   raw.smallTakerImb at 1h (small-class taker buy minus sell quote over the bar's total taker quote, from
 *   archiveflowbars folded from the Binance aggTrades archive with the qh-flow extractor), pooled IC with the
 *   perp forward return at horizon 1, execution lag 1, factor-ic.ts's pooled statistic; predicted sign NEGATIVE.
 *
 * FORWARD WINDOW: 2026-07-01T00:00:00.000Z to 2026-10-09T23:59:59.999Z (the last complete UTC day before this
 * lock). Data needed before it (indicator warmup, the 90-day thresholds and ATR quintiles) is read from
 * 2026-03-01 on; only bars inside the window are measured. Wilder RSI and ATR forget their start
 * geometrically, so starting the matrix on 2026-03-01 instead of 2022 changes no measured value beyond
 * floating-point noise (a committed test proves the equality on synthetic data, and the run checks it on
 * real data against a longer span). For B, factor-ic consumes its matrix warmup inside the window (about 8
 * days of July at 1h); this only shortens the window.
 *
 * DATA, all on the VPS: perp klines 5m, 1h, 4h, spot candles and HTF at 1h, futures metrics, snapshots and
 * the flow kind exported from 2026-03-01 to 2026-10-09; aggTrades for 2026-07 to 2026-09 from the monthly
 * archive and 2026-10-01 to 2026-10-09 from the daily archive, ingested with the qh-flow extractor in an
 * explicit lockbox-allowed forward mode. The dataset is hashed before any statistic is read.
 *
 * STATISTICS AND PASS RULE (each cell one-sided in its frozen direction, alpha = 0.05 / 3 per cell):
 * - A1, A2: the snipe statistic (excess win rate over the symbol x ATR-quintile baseline of the window), the
 *   common-grid circular-shift null with 1,000 draws, seed 7, minimum shift 30 days, null sd inflated by 1.25.
 *   CONFIRMED FORWARD iff the empirical one-sided p < 0.05 / 3 AND the inflated-z one-sided p < 0.05 / 3 AND
 *   the excess has the frozen sign in at least 7 of the symbols with 20 or more resolved trades (at least 7)
 *   AND in at least 60% of the calendar months with 20 or more resolved trades (at least 3 such months).
 * - B: the pooled IC on the window's common grid against the qh-flow common-offset null (1,000 draws, seed 7,
 *   30 days). CONFIRMED FORWARD iff the IC is negative AND the empirical one-sided p (draws at or below the
 *   observed) < 0.05 / 3 AND the inflated-z (1.25) one-sided p < 0.05 / 3 AND at least 7 of 10 symbols have a
 *   negative IC.
 * - Every cell also reports its effect size and the cost line: A1/A2 the win rate, baseline and maker/taker
 *   break-even win rates; B the IC against the 1h taker and maker breakeven ICs (0.0329, 0.0082).
 *
 * MONTHLY CONTINUATION: after this binding read, the same frozen code re-reads the cumulative window each month
 * on the VPS (new monthly archive files, new perp klines). Those reads are DESCRIPTIVE (running estimates and
 * intervals), never a new pass/fail, so repeated looks cannot manufacture a pass.
 *
 * EXPECTED, stated before any lockbox row is read: A1 and A2 most likely hold their sign with an excess near
 * +1 point and may or may not clear alpha 0.0167 on about 100 days; B most likely holds its sign but not
 * significance. Nothing here can become tradable: the A cells sit about 8 points below the maker break-even
 * win rate and B below the taker breakeven IC.
 *
 * TRIALS: 3 forward cells, ledger 2,078 -> 2,081.
 */

export const FORWARD_WINDOW = { start: '2026-07-01T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' } as const;
/** First data read for warmup and the 90-day thresholds; nothing before the window is measured. */
export const FORWARD_DATA_START = '2026-03-01T00:00:00.000Z';

export const FORWARD_CELLS = {
  A1: { column: 'raw.rsi', tail: 'bottom', level: 'many', timeframe: 'scalp', direction: 1 },
  A2: { column: 'raw.rsi', tail: 'top', level: 'many', timeframe: 'scalp', direction: -1 },
  B: { column: 'raw.smallTakerImb', interval: '1h', horizon: 1, executionLag: 1, returnSeries: 'perp', sign: -1 },
} as const;

/** Bonferroni over the three cells, one-sided each. */
export const FORWARD_ALPHA = 0.05 / 3;
export const FORWARD_NULL = { draws: 1_000, seed: 7, minShiftDays: 30, sdInflation: 1.25 } as const;
export const FORWARD_CONSISTENCY = {
  minSymbolTrades: 20,
  symbolsAgree: 7,
  minMonthTrades: 20,
  minMonths: 3,
  monthShare: 0.6,
} as const;
export const FORWARD_B_SYMBOLS_AGREE = 7;
/** 1h breakeven ICs from frontier.ts (taker, maker), reported beside B. */
export const FORWARD_B_BREAKEVEN_IC = { taker: 0.0329, maker: 0.0082 } as const;

export const FORWARD_LEDGER_BEFORE = 2_078;
export const FORWARD_LEDGER_AFTER = 2_081;

/*
 * EXECUTION NOTE E1 (2026-10-10): the dataset was exported from 2025-11-01 instead of 2026-03-01 so the span
 * check could compare against an earlier start; A still reads from FORWARD_DATA_START and B from the window.
 * Forward aggTrades: 2026-07 to 2026-09 monthly (30/30 files complete, 264,960 buckets, outOfOrder 0) and
 * 2026-10-01 to 10-09 daily (90/90 files, 288 buckets each); the window holds 290,880 flow buckets = 10 x 101
 * days x 288, no gap.
 *
 * RESULT, 2026-10-10 (BINDING READ): NO CELL IS CONFIRMED FORWARD. A2 and B keep their sign and size on the
 * never-read window and pass the empirical shift null, but fail the stricter inflated-z leg; A1 faded.
 *
 * Inputs, all on the VPS (image crypto-ops:forward from 9e24e43): dataset
 * 10e02ba86e010f3fefc69c35c33d411d347e4dd5da0ad62737e404cb0c5565ad ($HOME/forward-ds, 160 files, every series
 * complete to 2026-10-09 23:55); reports $HOME/forward-out/forward-rsi.json sha256
 * 59cdd1ce529991d16f962d4d5f8c9ea353af7fabafb57c13fe413973b2e4e8a9 and forward-small-taker.json sha256
 * d27e3fcdd65c687d666aa97602166bc89b1b884041f64432692b6935be3d5f20. Commands: forward-rsi.ts --dataset-dir
 * <it> --span-check-start 2025-11-01T00:00:00Z; forward-small-taker.ts --dataset-dir <it>; 1,000 draws, seed 7.
 *
 *   cell                     resolved  effect                       emp p   inflated-z p  months  symbols  verdict
 *   A1 RSI bottom 10%, long  15,423    +0.48 pts (50.36 vs 49.88)   0.272   0.311         2/4     7/10     FAIL
 *   A2 RSI top 10%, short    17,337    +1.46 pts (51.53 vs 50.07)   0.006   0.023         4/4     9/10     FAIL
 *   B small-trade imb, 1h    22,230    IC -0.0225 (t -3.28)         0.006   0.031         -       7/10     FAIL
 *   (alpha 0.0167 per cell; A2's 95% CI +0.38 to +2.52 points; A1's -1.09 to +1.93; B's null sd 0.0096 on a
 *   2,225-bar grid, observed z -1.87 at the 1.25 inflation)
 *
 * Reading:
 * - A2, overbought then short at 5m: the same sign and a larger excess than in confirmation (+0.82 there), every
 *   month and nine symbols agree, 5 of 1,000 shifted draws as extreme. It fails only the inflated-z leg. Its
 *   win rate (51.5%) is 10.7 points below the maker break-even of this window (62.2%; the window's 5m ATR is
 *   lower, 0.24% of price).
 * - A1, oversold then long: faded to +0.48 points, not significant. The pair was not symmetric forward.
 * - B, small-trade taker imbalance at 1h: IC -0.0225, larger than the hold-out's -0.0154, same sign; 7 of 10
 *   symbols negative (the alts carry it, BTC and ETH do not). Fails only the inflated-z leg. |IC| is above the
 *   1h maker breakeven IC (0.0082) and below the taker one (0.0329).
 * - Span check: BTCUSDT raw.rsi, tail flags and label outcomes identical (max difference 0) over the window's
 *   29,088 bars whether the data starts 2025-11-01 or 2026-03-01.
 * - Expected outcome as stated in the lock: A1 wrong (it did not hold), A2 right on sign and size, B right
 *   (sign held, significance short of the locked bar).
 *
 * MONTHLY CONTINUATION: descriptive re-reads of the cumulative window from 2026-07-01, never a new pass/fail.
 */
