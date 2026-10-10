/**
 * Causal, per-bar factor matrix built from the same code paths the live
 * scorer and backtests use: prepareBacktest's precomputed indicator suites
 * and SuperTrend, computeSignalScore for the composite and per-category
 * scores, and the HTF context already exported per bar by C1's
 * export-dataset.ts. No I/O: candles, snapshots, and HTF rows are supplied
 * by the caller (typically load-dataset.ts) and nothing here reaches Mongo.
 *
 * Every factor is NaN before the shared indicator warmup and whenever its
 * own input is missing at that bar (no snapshot, no HTF context, too few
 * bars of price history) -- never silently defaulted to zero, so a research
 * agent's IC measurement never mistakes "no data" for "neutral reading".
 *
 * Known divergence from live scoring: computeIndicatorsForStyle (the live
 * path, src/lib/indicators/compute-for-style.ts) nulls the raw Ichimoku
 * indicator for scalping before interpretation, so no Ichimoku signal ever
 * reaches the scorer at that style. prepareBacktest/interpretIndicatorsAtBar
 * (src/lib/backtest/optimized-engine.ts, shared with ordinary backtesting)
 * has no such style awareness -- every style gets Ichimoku interpreted, a
 * pre-existing divergence this file cannot fix at the source without
 * touching src/, and which any backtest/harness branch built on
 * optimized-engine.ts inherits too. computeFactorMatrix works around it
 * locally, for factor computation only, by stripping the Ichimoku reading
 * and signal from the suite it hands to computeSignalScore when style is
 * scalping (see excludeIchimokuForScalping below).
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { SignalComponent, SignalWeights } from '@/types/signal';
import type { OHLCV } from '@/types/market';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { FUNDING_INTERVAL_MS } from '@/lib/backtest/funding';
import { prepareBacktest } from '@/lib/backtest/optimized-engine';
import { computeSignalScore } from '@/lib/signals/scorer';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import type { CandleRow, FlowRow, HtfRow, MetricsRow, OptionsRow, PerpCandleRow, SnapshotRow } from './dataset-format';
import { OPTIONS_SLOT_MS } from '@/lib/options-flow';
import { alignToBars, METRICS_SLOT_MS } from '@/lib/archive-ingestion';
import { intervalToMs } from '@/lib/intervals';
import { MARKET_SESSIONS, isSessionMeaningful, sessionOfCandleClose } from '@/lib/sessions';
import { trailingZScore } from '@/lib/stats/trailing-z';

export interface FactorMatrix {
  names: string[];
  categories: string[];
  values: Array<Float64Array>;
  warmupBars: number;
  timestamps: number[];
  closes: number[];
  /**
   * Perpetual close per bar, exact-timestamp join, NaN where the dataset has
   * no perp bar. The venue every backtest charges; --return-series perp
   * measures forward returns on it.
   */
  perpCloses: number[];
}

export interface FactorMatrixInput {
  candles: CandleRow[];
  snapshots: SnapshotRow[] | null;
  /**
   * The symbol's 1h snapshot rows, which the scorer's L/S z is computed on
   * (configVersion 8). Required when `snapshots` are 4h or 1d rows, ignored at
   * 1h and finer, where `snapshots` are the 1h rows already. Pass [] when the
   * dataset has no 1h file: the L/S signal then abstains.
   */
  lsRows1h?: SnapshotRow[] | null;
  htf: HtfRow[];
  interval: string;
  /**
   * The archive's 5m futures-metrics grid for this symbol, from
   * scripts/research/load-dataset.ts's loadMetrics. Optional: omit it and
   * every metrics-derived factor is NaN for the whole series, which is what
   * every study before this input existed measured.
   */
  metrics?: MetricsRow[] | null;
  /** Perpetual bars for this symbol and interval, the traded series. */
  perp?: PerpCandleRow[] | null;
  /** The premium index series for the same symbol and interval. */
  premiumIndex?: PerpCandleRow[] | null;
  /**
   * Hourly Deribit options-flow rows for this symbol's OWN currency (see
   * scripts/research/dataset-format.ts's optionsCurrencyOf), from
   * load-dataset.ts's loadOptions. Optional and NaN throughout when omitted,
   * same rule as metrics/perp. A symbol with no options market (anything but
   * BTCUSDT/ETHUSDT) never has one.
   */
  options?: OptionsRow[] | null;
  /**
   * BTC's hourly options-flow rows, read by EVERY symbol as the market-wide
   * options reading -- passed here rather than derived, since
   * computeFactorMatrix is per symbol and has no access to another symbol's
   * dataset file. Identical across every symbol at a given bar by
   * construction (see MARKET_OPTIONS_NAMES below).
   */
  marketOptions?: OptionsRow[] | null;
  /**
   * The archive's 5-minute taker-flow buckets for this symbol, from
   * load-dataset.ts's loadFlow. Optional: omit it (or pass an empty list) and
   * the four qh-flow columns are NaN for the whole series.
   */
  flow?: FlowRow[] | null;
  /**
   * Trading style whose indicator profile and DEFAULT_TEMPLATE_WEIGHTS score
   * the bars. Omitted, it is styleForInterval(interval), exactly as before;
   * the v8 re-score passes it to score swing_trading at 1d.
   */
  style?: TradingStyle;
}

// Fixes each interval's indicator periods and DEFAULT_TEMPLATE_WEIGHTS, per the brief.
const STYLE_FOR_INTERVAL: Record<string, TradingStyle> = {
  '5m': 'scalping',
  '15m': 'day_trading',
  '1h': 'day_trading',
  '4h': 'swing_trading',
  '1d': 'position_trading',
};

/** Exported so export-dataset.ts resolves the same style for the same interval when it needs the style's indicator config (e.g. for the HTF context). */
export function styleForInterval(interval: string): TradingStyle {
  const style = STYLE_FOR_INTERVAL[interval];
  if (!style) {
    throw new Error(`No trading style mapped for interval "${interval}"`);
  }
  return style;
}

/** See this file's header: strips Ichimoku's raw reading and derived trend signal, matching computeIndicatorsForStyle's scalping behavior that prepareBacktest itself does not have. */
function excludeIchimokuForScalping(suite: IndicatorSuite): IndicatorSuite {
  if (!suite.ichimoku && !suite.signals.trend.some((s) => s.name === 'Ichimoku')) {
    return suite;
  }
  return {
    ...suite,
    ichimoku: null,
    signals: {
      ...suite.signals,
      trend: suite.signals.trend.filter((s) => s.name !== 'Ichimoku'),
    },
  };
}

export function toOHLCV(row: CandleRow): OHLCV {
  return {
    timestamp: row.t,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
    ...(row.tbv !== null ? { takerBuyVolume: row.tbv } : {}),
  };
}

/** Inverse of the export side's row shaping in scripts/research/export-dataset.ts. */
export function toLeanSnapshot(row: SnapshotRow): LeanSnapshot {
  return {
    timestamp: row.t,
    data: {
      fundingRate: row.fundingRate
        ? { rate: row.fundingRate.rate, markPrice: row.fundingRate.markPrice ?? undefined }
        : undefined,
      longShortRatio: row.longShortRatio ?? undefined,
      openInterest: row.openInterest ?? undefined,
      newsSentiment: row.newsSentiment ?? undefined,
      fearGreed: row.fearGreed ?? undefined,
    },
  };
}

const CATEGORY_ORDER: (keyof SignalWeights)[] = [
  'trend',
  'momentum',
  'volume',
  'volatility',
  'futures',
  'sentiment',
  'htf',
];

/**
 * PRE-REGISTRATION, 2026-09-25, for the three book-depth columns added below.
 * Written before any measurement; the results go in factor-ic.ts's header.
 *
 * All three come from `depthNotional1` and `depthNotional5`, which
 * `export-dataset.ts` has always written into `MetricsRow` and which no factor
 * has ever read. They need no ingestion and no re-export.
 *
 * MEASURED AT 5m AND 15m FIRST, not at 4h. Recovering per-trade dispersion from
 * the recorded bootstrap CIs puts the statistical bar at about 0.010% at 5m
 * against 0.450% at 4h, so a 4h reading cannot be proven at the sample on hand
 * even if the effect is real. At lag 1, per the standing ruling.
 *
 * SURVIVOR RULE, FIXED NOW: the existing rule (|ic| >= 0.02, two or more
 * horizons, 60% quarter agreement, 70% symbol agreement) with |t| raised from
 * 2.5 to 3.15, and Benjamini-Hochberg FDR at 0.10 across the phase's cells.
 * 3.15 is the empirically calibrated value: |t| > 2.5 fires on 4.0% to 4.5% of
 * zero-edge trials for a persistent factor against a nominal 1.24%, and at 3.15
 * no existing survivor is lost.
 *
 * PREDICTED SIGNS:
 *
 * - `raw.depthFlow1`: POSITIVE, and this is the only one with a real prior.
 *   Order-flow imbalance is continuation-shaped in the literature: price
 *   follows flow. That is the OPPOSITE sign to `raw.depthImbalance1`, which
 *   this program measured as contrarian at 4h and 1d (lag 1: 4h h16 -0.0408
 *   t -5.8, 1d h8-32). Level crowded means fade; flow means follow. The sign
 *   contrast is the test, and a negative flow IC would mean the two columns are
 *   measuring the same thing and this adds nothing.
 *   It also matters for execution: Stage 0 established that a passive entry on
 *   a mean-reversion signal is adversely selected, so only a
 *   continuation-shaped signal can use the 0.04% maker cost bar at all.
 *
 * - `raw.depthNotional1`: NO SURVIVOR EXPECTED. A liquidity level is a state
 *   variable, not a direction. If it survives as a direct factor it is more
 *   likely proxying market regime or a symbol's size than predicting returns,
 *   and it should be treated as a conditioner rather than a signal.
 *
 * - `raw.depthSlope`: NO SURVIVOR EXPECTED, same reasoning. A book that thickens
 *   away from the touch implies higher impact per unit size, which is an
 *   execution cost input rather than a forecast.
 *
 * Recording two predicted non-survivors matters as much as the one predicted
 * survivor: if all three clear the rule, the likeliest explanation is that the
 * rule is too loose for this input, not that three independent edges appeared.
 *
 * STAGE 2 PRE-REGISTRATION, 2026-09-25, for the four columns after those.
 * Written before any measurement. Measured at 5m, 1h AND 4h in one pass, not
 * one interval at a time: Stage 1 had to add intervals after seeing its first
 * result, which makes the later ones post-hoc, and doing all three together
 * avoids repeating that.
 *
 * - `raw.varianceRatio`: NO SURVIVOR EXPECTED as a direct factor. VR(q) is a
 *   REGIME reading, not a direction: above 1 the series trends, below 1 it
 *   reverts. Asking whether the level of the ratio predicts the sign of the
 *   next return is not the hypothesis, and a survivor here would more likely
 *   mean it is proxying volatility than forecasting anything.
 *
 * - `raw.ret1InMeanReversion` and `raw.ret1InTrend` ARE the hypothesis. They
 *   are the same one-bar return split by the regime the bar sits in, so
 *   comparing their two ICs asks the question the ratio exists to answer:
 *   does knowing the regime tell you when reversal works? PREDICTION: both
 *   negative, since Phase 3 found reversal dominates intraday, but materially
 *   MORE negative in the mean-reversion subset. The conditioner earns its
 *   place only through that gap.
 *   FALSIFICATION, fixed now: if the trend subset's IC is as negative as, or
 *   more negative than, the mean-reversion subset's, then the variance ratio
 *   is either mis-signed or measuring nothing here, and no further work should
 *   be done on it. A gap smaller than about a third of the unconditional |ic|
 *   counts as no gap.
 *
 * - `raw.fundingProximity`: WEAK NEGATIVE, probably no survivor. Funding
 *   settles on a known 8h clock, so a bar's distance from the next settlement
 *   is an event-time coordinate that nothing here has ever used. If crowded
 *   longs close into a settlement they are about to pay for, high positive
 *   funding near settlement should precede lower returns, the same contrarian
 *   direction `raw.fundingZ` already shows. The new content is the event-time
 *   axis, not the funding level.
 *
 * PHASE B PRE-REGISTRATION, 2026-09-26, for the five columns after those and
 * the cross-symbol column in cross-symbol-factors.ts. Written before any
 * measurement. Measured at 15m, 1h AND 4h in one pass at lag 1 (5m excluded in
 * advance: its maker breakeven IC is 0.027 against a program-best 0.009),
 * horizons 1,2,4,8,16,32,48 at 15m so the 4 to 12 hour prior is reachable.
 * Survivor rule with |t| >= 3.15 and Benjamini-Hochberg FDR 0.10 across every
 * cell of the phase, both modes, both return series (report-schema.ts,
 * survivor-table.ts). Tradability floor for a survivor: maker breakeven IC of
 * the interval (1h 0.0044 single leg, about 0.017 cross-sectional), and the
 * phase closes with no harness run if nothing clears it.
 *
 * - `raw.hourOfDayDrift` (+): trailing 60-day mean of this symbol's one-bar
 *   return over EARLIER bars sharing the same time of day, the bar itself
 *   excluded so no term of its own return enters. Time-series axis only: it
 *   is market-wide by nature and per-bar demeaning would zero it by
 *   construction. The literature says BTC calendar effects are gone
 *   post-2023, so the expected outcome is null; it is cheap enough to test.
 * - `raw.sessionDrift` (+): the same over the five fixed-UTC sessions of
 *   src/lib/sessions.ts, NaN where a session is not meaningful (4h).
 * - `raw.depthNotionalZ` (+, weak, NO SURVIVOR EXPECTED): within-symbol
 *   30-day trailing z of log depthNotional1, the column Stage 1 deferred.
 *   Stage 1 measured the raw level at +0.0248 at 15m h16 with symbol
 *   agreement 0.80 and QUARTER agreement 0.45, the signature of a
 *   non-stationary level; the z removes the drift. A state variable, so a
 *   survivor here is more likely regime than direction.
 * - `raw.ret1InHighTaker` and `raw.ret1InLowTaker` ARE the conditioning
 *   hypothesis, not standalone signals: the one-bar return split by whether
 *   the bar's absolute taker imbalance sits above (z > 0) or at or below its
 *   30-day trailing mean. PREDICTION: both negative (reversal), MORE negative
 *   in the HIGH-intensity subset (arXiv 2608.21888: reversal concentrates
 *   after aggressive taker flow and grows with intensity, while depth
 *   consumed conditions nothing, which agrees with Stage 1). FALSIFICATION,
 *   fixed now: a gap smaller than a third of the unconditional |ic|, or a
 *   deeper LOW subset, means the intensity conditions nothing. Diagnostics
 *   only, never a family: a gated reversal rule would be a third rule shape
 *   on ret1 under the standing ruling.
 * - `raw.btcLeadLag` (+ at h1 to h4 for alts, weaker at 1h than 15m):
 *   BTC's one-bar return minus the equal-weight cross-sectional one-bar
 *   return, read for every non-BTC symbol, NaN for BTC and where fewer than
 *   five symbols have a finite return. Delayed alt reaction to BTC (JEDC
 *   2024; Springer APFM 2026, paywalled, effect sizes unverified). Both axes.
 *
 * DROPPED without a slot: same-symbol spot-to-perp lead-lag (arbitrage
 * closes in milliseconds; the perpSpotSpreadPct artifact family), day-of-week
 * drift (folded into time of day), retail-versus-top-trader spread (both legs
 * measured at 4h and 1d only, same sign).
 *
 * ADDENDUM, 2026-09-26, written after the 4h and 1h time-series runs were read
 * and BEFORE the 15m run was read. Two properties of `raw.btcLeadLag` were
 * found by review, not by measurement, and are ruled on here so they are not
 * decided after a result:
 *
 * - It has NO cross-sectional content by construction: b_t - m_t is the same
 *   number for every non-BTC symbol at a bar, so a per-bar rank across symbols
 *   is undefined. It is measured on the time-series axis only and is dropped
 *   from the cross-sectional pass. (The same reasoning excluded the drift
 *   columns above; the original "both axes" assignment was wrong.)
 * - The market mean m_t includes the read symbol's own ret1 with weight -1/N,
 *   and ret1 reverses at these horizons, so the column carries a positive
 *   own-return term of about +0.002 at 15m and +0.006 at 1h in IC units, the
 *   pre-registered sign. Below the 0.02 floor on its own, but it biases the
 *   sign test. CONTROL, pre-registered now: `raw.btcLeadLagLoo`, BTC's ret1
 *   minus the equal-weight mean over the OTHER alts (the read symbol and BTC
 *   both excluded), NaN for BTC and below five symbols. PREDICTION: same sign
 *   (+), and the gap btcLeadLag - btcLeadLagLoo bounds the contamination at
 *   about the figures above. If btcLeadLag clears the rule anywhere and the
 *   LOO control does not, the survival is the own-return reversal in disguise
 *   and is recorded as such.
 * - Recorded before the 15m read: at 1h btcLeadLag was +0.0219 (h1, t 12.5)
 *   and +0.0187 (h2), failing the two-horizon |ic| leg by 0.0013.
 *
 * PHASE B RESULTS, 2026-09-26. Dataset e84cd66dbe01, lockbox applied, lag 1, ten
 * symbols, 15m (horizons to 48), 1h and 4h measured in one pass, both axes, then
 * one leave-one-out control pass at 1h and 15m. Phase-wide survivor table
 * (survivor-table.ts, FDR 0.10 over 2,361 cells, 1,371 rejected): the FDR moved
 * no count. Controls reproduced the recorded lag-1 table: raw.ret1 h1 -0.0121
 * (15m), -0.0291 (1h), -0.0157 (4h); raw.depthImbalance1 4h h8 -0.0269 t-4.9,
 * h16 -0.0408 t-5.8, h32 -0.0515 t-5.7; raw.topTraderPositionRatio 4h h32
 * -0.0782 t-4.9 (recorded -0.0783, causal join); raw.depthFlow1 1h h2 +0.0073.
 *
 * TIME-SERIES AXIS: NO NEW COLUMN SURVIVES AT ANY INTERVAL.
 *
 *   column                 15m best            1h best              4h best             verdict
 *   raw.btcLeadLag         h2 +0.0067 t+3.1    h1 +0.0219 t+12.5    h1 +0.0100 t+3.5    near miss at 1h
 *   raw.btcLeadLagLoo      h2 +0.0058 t+2.7    h1 +0.0205 t+11.8    (not run)           control, same shape
 *   raw.hourOfDayDrift     h8 -0.0070 t-4.0    h2 -0.0161 t-10.0    h16 +0.0094 t+2.3   nothing
 *   raw.sessionDrift       h16 -0.0321 t-6.3   h8 -0.0277 t-9.9     NaN by design       survives, WRONG sign
 *   raw.depthNotionalZ     h1 +0.0070 t+3.9    h8 -0.0229 t-6.1     h8 -0.0137 t-1.9    nothing (one horizon)
 *
 * raw.btcLeadLag is the strongest fine-interval new-input reading the program has
 * recorded (previous best raw.depthFlow1 +0.0092 t8.0 at 5m): right sign, monotone
 * decay h1 +0.0219, h2 +0.0187, h4 +0.0133, h8 +0.0026, the coherent shape of a
 * lead-lag with a one-to-two-hour half-life, continuation-shaped so maker
 * fillable, 5x the 1h maker breakeven. The LOO control puts the own-return term
 * at 0.0011 to 0.0014 (h1 +0.0205 t11.8, h2 +0.0176), far under the predicted
 * bound of about 0.006, so it is NOT the reversal in disguise. It fails the rule
 * twice: h2 is 0.0187 against the 0.02 floor (0.0176 LOO), and quarter agreement
 * at h1 is 0.63 (0.58 LOO), so the effect is not stable across quarters. Recorded
 * as a near miss, not a survivor. Not measured cross-sectionally (no content).
 *
 * raw.sessionDrift survives at 15m and 1h with the WRONG sign (pre-registered +),
 * and raw.hourOfDayDrift points the same way: both carry the 60-day trailing mean
 * return, which is the slow reversal raw.ret20 already carries (-0.02 at 1h). The
 * column design did not subtract the unconditional trailing mean, so this is a
 * correlated variant of an existing factor, the false-positive channel the
 * governance section named, and is recorded as such, not as a finding. A seasonal
 * DEVIATION column (bucket mean minus the overall trailing mean) is what a future
 * pre-registration would test; the literature expectation of null stands.
 *
 * TAKER-INTENSITY CONDITIONING, pre-registered falsification at a third of the
 * unconditional |ic|:
 *
 *   iv   h   unconditional  high taker      low taker       gap %   verdict
 *   15m  2   -0.0159        -0.0184 t-5.8   -0.0088 t-3.2    60%    holds
 *   15m  8   -0.0123        -0.0201 t-6.3   -0.0049 t-1.8   124%    holds
 *   1h   1   -0.0291        -0.0324 t-12.3  -0.0269 t-12.0   19%    fails
 *   4h   1   -0.0157        -0.0154 t-3.5   -0.0158 t-4.3     0%    fails
 *
 * Direction consistent everywhere (high deeper), magnitude only at 15m, where
 * the conditioned reversal (-0.020 at h8) sits below the 15m taker breakeven
 * (0.039) and reversal cannot use maker fills. A diagnostic, never a family.
 *
 * CROSS-SECTIONAL AXIS (existing inputs re-read against per-bar demeaned
 * returns, pooled statistic = per-bar Fama-MacBeth IC after the fix recorded in
 * factor-ic.ts): survivors 12/60 at 15m, 14/60 at 1h, 9/58 at 4h. The relative
 * axis carries information the time-series axis does not:
 *
 *   raw.realizedVol20  1h  h1 -0.0214 t-9.7, h4 -0.0350 t-10.2, h32 -0.0745 t-8.2  quarters 0.96 symbols 1.00
 *   raw.realizedVol20  4h  h1 -0.0337 t-9.6, h4 -0.0614 t-11.3, h32 -0.0788 t-5.8  quarters 0.91 symbols 1.00
 *   raw.realizedVol20  15m h8 -0.0273 ... h48 -0.0623 t-4.5, symbols 0.60 (near miss)
 *   raw.ret5           1h  h1 -0.0215 t-11.3, h2 -0.0264 t-12.3 (relative reversal)
 *   raw.ret5           15m h8 -0.0281 t-7.2; raw.ret20 15m 2-48 symbols 1.00
 *   raw.fundingRate, raw.fundingProximity, raw.longShortRatio, raw.topTraderPositionRatio,
 *   raw.depthImbalance1 (1h 8-32, h32 -0.0367 t-6.9), raw.depthImbalance5: survive at 1h and 4h
 *
 * Symbols with higher recent realised volatility lag their peers over the next
 * 1 to 32 hours, every symbol and 91 to 96% of quarters agreeing: the
 * cross-sectional variance effect the literature scan recorded at weekly
 * horizons (Bianchi et al.), seen here at 1h and 4h. Relative funding, relative
 * positioning and relative depth imbalance carry the same contrarian sign they
 * carry in the time series. These are level-shaped, slow-turnover readings at 2
 * to 7x the two-leg maker floor (about 0.017 at 1h). Relative reversal (ret5,
 * ret20, rsi) is reversal-shaped and does not reach the two-leg taker floor
 * (about 0.067). No harness family exists for a cross-sectional book: the
 * discrete harness is single-symbol and the exposure container is per-symbol
 * exposure, not rank. Tradability is therefore a new-plan question.
 *
 * VERDICT UNDER THE PRE-REGISTERED KILL CRITERION: on the time-series axis it
 * fires (no new column survives above its interval's maker floor). On the
 * cross-sectional axis it does not: several existing inputs survive at 1h and
 * 4h above the two-leg floor. Phases C and D (1m and aggTrades ingests) were
 * aimed at fine-interval time-series content and are not motivated by this
 * result; a cross-sectional container at 1h and 4h is. That decision is the
 * user's.
 *
 * DATASET NOTES. The 15m cross-section has 26,766 bars with five or more symbols
 * (about 279 days), against 41,098 at 1h (4.7 years) and 16,598 at 4h: 15m
 * evidence is the thinnest and its quarter agreement spans about four quarters.
 * The eight reports were written with one task id per mode; the phase table was
 * built from copies relabelled pB-<mode>-<interval> because evaluatePhaseSurvivors
 * refuses duplicate ids (the id is a label, in no hash or spot check).
 *
 * OPTIONS INPUTS (exploration, 2026-09-28). Task 3b stores hourly Deribit
 * options-flow rows (OptionsFlowHour, src/lib/models/options-flow-hour.ts):
 * the DVOL implied-vol index and trade-flow aggregates (call/put notional by
 * taker side, net delta, net dollar gamma, and two implied-vol readings).
 * `options` carries the symbol's OWN currency (BTCUSDT/ETHUSDT only,
 * scripts/research/dataset-format.ts's optionsCurrencyOf); `marketOptions`
 * always carries BTC's file, read by every symbol as the market-wide
 * reading. JOIN RULE: an hourly row is observable at its hour's CLOSE
 * (t + OPTIONS_SLOT_MS - 1), the same "published by the time a factor reads
 * it" reasoning the 5m metrics grid join uses above, and joins onto
 * `alignToBars(barCloses, ..., Math.max(intervalMs, 2 * OPTIONS_SLOT_MS))` --
 * a bar more than two hours past the last options row is NaN, never a stale
 * carry-forward. Before alignment, four hourly series are precomputed over
 * CONSECUTIVE hours only (a gap -- a missing hour, or a null measure inside
 * an hour that exists -- makes that hour's 24-hour window NaN, never a
 * partial sum): `deltaFlow24` and `gammaFlow24`, 24-hour trailing sums of
 * netDelta and netDollarGamma; `putCallVol24`, the 24-hour put-to-call
 * notional ratio (NaN when the call sum is zero); `skew24`, putIv25 minus
 * callIv25 as an unweighted mean of the hours in the window whose own
 * putIv25/callIv25 pair is finite (this one alone tolerates a thin-hour gap
 * inside an otherwise gap-free window, since it is already a mean rather
 * than a sum). `raw.mktDvolZ30`, `raw.mktOptDeltaFlow24Z`,
 * `raw.mktOptGammaFlow24Z`, `raw.ownDvolZ30`, `raw.ownOptDeltaFlow24Z` and
 * `raw.ownOptGammaFlow24Z` are `trailingZScore` over the aligned series with
 * `daysToBars(DEPTH_NOTIONAL_Z_DAYS)` and `DEPTH_NOTIONAL_Z_MIN_SAMPLES`, the
 * same helper and constants `raw.depthNotionalZ` uses; `raw.mktOptPutCallVol24`,
 * `raw.mktOptSkew24`, `raw.ownOptPutCallVol24` and `raw.ownOptSkew24` are the
 * aligned levels, not z-scored. Two Stage-2-style diagnostics, masks of
 * `raw.ret1` rather than standalone signals: `raw.ret1InHighDvol` /
 * `raw.ret1InLowDvol` split by the top/bottom tercile of a trailing 90-day
 * window of the aligned market DVOL close, and `raw.ret1InPosGammaFlow` /
 * `raw.ret1InNegGammaFlow` split by the sign of the aligned market
 * `gammaFlow24`. `MARKET_OPTIONS_NAMES` (the five `mkt` columns) is
 * identical across every symbol at a bar by construction -- marketOptions is
 * always BTC's file -- the same "no cross-sectional content" reasoning
 * factor-ic.ts already applies to raw.btcLeadLag. When `options` and
 * `marketOptions` are both absent (the default until a dataset carries the
 * `options` kind), every column this paragraph describes is NaN throughout,
 * exactly like every other optional input in this file.
 *
 * OPTIONS TRIAGE RESULTS (2026-09-28, develop slice to 2022-12-31 on the
 * options-enabled export research-p4o, hash 3483a511, execution lag 1, ten
 * symbols; the options rows begin 2021-10-01, so every options cell is
 * measured on 2021-10 to 2022-12, one bear regime). At 1h: `raw.mktDvolZ30`
 * h8 +0.0326 t 4.63 [0.016, 0.046], h16 +0.0472 t 4.78, h32 +0.0611 t 4.64,
 * 10/10 symbols, 4/5 quarters, the program's first new-input survivor at 1h;
 * `raw.mktOptSkew24` h8 +0.0282 t 3.97 (put-rich skew precedes HIGHER
 * returns, the opposite of the thread claim); `raw.mktOptDeltaFlow24Z` h1 to
 * h16 within +/-0.008, h32 +0.0262 t 2.27. At 4h: `raw.mktDvolZ30` h32
 * +0.1228 t 5.01; `raw.mktOptDeltaFlow24Z` h8 +0.0273 t 2.42, h16 +0.0656
 * t 4.89 [0.040, 0.089], h32 +0.0439 t 3.05; `raw.mktOptGammaFlow24Z` h32
 * -0.0601 t -4.12; `raw.mktOptPutCallVol24` h32 +0.0812 t 3.98;
 * `raw.ret1InNegGammaFlow` h2 -0.0615 t -6.87 against unconditional
 * -0.0118 at h8 and `raw.ret1InPosGammaFlow` h4 +0.0230 (the 4h reversal is
 * much stronger when customers sold gamma, mild continuation when
 * they bought; the unconditional `raw.ret1` is -0.0118 at h8, so the
 * like-for-like ratio is about 52 at h2 and about 3.6 at h8). At 15m the
 * delta-flow, gamma-flow and put/call columns sit below the 0.02 floor;
 * `raw.mktDvolZ30` clears it at h16 (+0.0203 t 4.10) and h32 (+0.0294
 * t 4.20, 10/10 symbols) and the skew at 8h (+0.0294 t 4.2).
 *
 * WHAT THE RULES BUILT ON THESE CELLS DID (exploration-families.ts header
 * has the tables): the long-only DVOL-spike and skew-spike rules and the
 * gamma-regime fade LOSE on the same slice at 1h, 4h and 15m without
 * exception (a 2 to 3 ATR stop is hit inside the high-vol bars the drift
 * needs), while delta-flow continuation paid +1.7% to +2.0% per trade at 1h
 * and 4h (6 of 8 gates at 1h) and then lost on EVERY symbol in 2023 with
 * parameters fixed. A record-only 2023 read of `raw.mktOptDeltaFlow24Z`
 * alone (no other column's 2023 IC was computed) shows why: at 1h the
 * column's relation to the next 4 to 16 hours flipped from about zero to
 * h4 -0.0353 t -6.58, h8 -0.0405 t -5.52, h16 -0.0374 t -3.70; at 4h the
 * 64-hour cell fell to +0.0176 t 1.12 while the 5-day cell held (+0.0486
 * t 2.87, 9/10 symbols). The sign of "options flow leads the underlying" is
 * regime-dependent on this data, and a whole-distribution rank IC at the
 * multi-day horizon does not reach a tail-entry rule with an ATR stop, the
 * same IC-to-rule gap Phase 3b recorded for the positioning factor.
 *
 * QH-FLOW COLUMNS (2026-10-09): `raw.qhOpenImb`, `raw.fiveMinOpenImb`,
 * `raw.largeTakerImb` and `raw.smallTakerImb`, appended after every other
 * column and fed by the `flow` input (the 5-minute taker-flow buckets in
 * `archiveflowbars`). Their definitions are pre-registered in the COLUMNS
 * section of the header of scripts/research/qh-flow.ts and are LOCKED there;
 * this file implements them literally and does not restate them. The
 * implementation notes (recorded before any IC run): a bar's buckets are the
 * 5-minute buckets with open <= bucketStart < open + interval, and any
 * missing bucket makes all four columns NaN for that bar; like every raw
 * column they are NaN before warmupBars.
 *
 * EXPLORATION COLUMNS, 2026-09-28, for the calendar and conditioning claims
 * the reading produced (Monday/Wednesday direction, OPEX-style weekday
 * effects, "short the session open", Asia is chop, round numbers are levels,
 * down moves are sharper, trending regimes weaken reversal). Two are a
 * DEVIATION form of the Phase B seasonal columns the PHASE B RESULTS block
 * above named as the next test: raw.hourOfDayDrift and raw.sessionDrift both
 * carry the 60-day trailing mean return, the same slow reversal raw.ret20
 * already carries, because neither column subtracted the unconditional
 * trailing mean. The other eight are Stage-2-style diagnostics, masks of
 * raw.ret1 rather than standalone signals, following the pattern
 * raw.ret1InMeanReversion/InTrend and raw.ret1InHighTaker/InLowTaker set: the
 * two subset ICs are compared and read as the gap between them (a third of
 * the unconditional |ic| counts as a gap), never as survivors on their own.
 *
 * `raw.hourOfDayDriftDev` and `raw.weekdayDriftDev` subtract the trailing
 * unconditional mean of ret1 -- obtained from the SAME `seasonalDriftSeries`
 * call with a single, constant bucket, so both terms exclude the bar itself
 * identically -- from the bucketed drift, leaving only the bucket's
 * departure from the overall trailing mean. `raw.hourOfDayDriftDev` is NaN
 * wherever `raw.hourOfDayDrift` is (1d and coarser, no time-of-day content).
 * `raw.weekdayDriftDev` buckets on `getUTCDay()` (7 buckets) and is NaN at
 * 1d by the ordinary minSamples rule (about 8 readings in 60 days, below
 * SEASONAL_DRIFT_MIN_SAMPLES) -- not by an added interval gate.
 *
 * `raw.ret1InAsia` / `raw.ret1InNyOverlap`: the "Asia is chop" / "short the
 * session open" claims, ret1Series masked by sessionOfCandleClose, NaN
 * together where isSessionMeaningful(interval) is false (4h, 1d).
 *
 * `raw.ret1NearRound` / `raw.ret1FarRound`: the "round numbers are levels"
 * claim, split by whether the bar's close sits within 0.2% of the nearest
 * two-significant-figure price level.
 *
 * `raw.ret1AfterDown` / `raw.ret1AfterUp`: the "down moves are sharper"
 * claim, ret1 conditioned on the sign of the PRECEDING bar's return.
 *
 * `raw.ret1InHighVolRatio` / `raw.ret1InLowVolRatio`: the "trending regimes
 * weaken reversal" claim, ret1 split at 0.7 of a realised-vol ratio (sd of
 * log returns over the trailing 24h divided by the trailing 168h, ddof 1) --
 * a ratio-of-vols regime reading in the spirit of raw.varianceRatio, not a
 * rebuild of it: VR(4) over a 120-bar window answers whether the series
 * trends or reverts, this answers whether realised volatility has itself
 * picked up relative to its own recent history. Structurally NaN at 1d and
 * whenever the 168h window exceeds the series: hoursToBars(24) is a single
 * bar at 1d, and a one-sample variance (ddof 1) has no degrees of freedom,
 * so the column is NaN there without a separate interval gate, the same
 * mechanism raw.weekdayDriftDev relies on.
 *
 * `EXPLORATION_DIAGNOSTIC_NAMES` is the eight `ret1In*`/`ret1Near*`/
 * `ret1After*` names above, exported for the S0 IC triage record; the two
 * `*Dev` columns are deviations, not diagnostics of raw.ret1, and are left
 * out of it.
 */
const RAW_NAMES = [
  'raw.rsi',
  'raw.emaSpreadPct',
  'raw.atrPct',
  'raw.fundingRate',
  'raw.longShortRatio',
  'raw.takerBuyRatio',
  'raw.fearGreed',
  'raw.htfTrend',
  'raw.ret1',
  'raw.ret5',
  'raw.ret20',
  'raw.realizedVol20',
  // Archive-only inputs. Before scripts/ops/ingest-archive.ts existed, Binance
  // REST served these for about 30 days, so stored open interest and
  // positioning covered 11.0% of 1h bars and nothing before 2026-03-03.
  'raw.oiChange1',
  'raw.oiChange8',
  'raw.oiPriceDiv',
  'raw.takerLongShortRatio',
  'raw.topTraderPositionRatio',
  'raw.globalAccountRatio',
  'raw.fundingZ',
  'raw.basisPct',
  'raw.perpSpotSpreadPct',
  'raw.depthImbalance1',
  'raw.depthImbalance5',
  'raw.depthNotional1',
  'raw.depthSlope',
  'raw.depthFlow1',
  'raw.varianceRatio',
  'raw.ret1InMeanReversion',
  'raw.ret1InTrend',
  'raw.fundingProximity',
  'raw.hourOfDayDrift',
  'raw.sessionDrift',
  'raw.depthNotionalZ',
  'raw.ret1InHighTaker',
  'raw.ret1InLowTaker',
  // Options inputs (Deribit DVOL and trade flow, Task 3c). See the "OPTIONS
  // INPUTS" paragraph above for the join rule and every column's definition.
  'raw.mktDvolZ30',
  'raw.mktOptDeltaFlow24Z',
  'raw.mktOptGammaFlow24Z',
  'raw.mktOptPutCallVol24',
  'raw.mktOptSkew24',
  'raw.ownDvolZ30',
  'raw.ownOptDeltaFlow24Z',
  'raw.ownOptGammaFlow24Z',
  'raw.ownOptPutCallVol24',
  'raw.ownOptSkew24',
  'raw.ret1InHighDvol',
  'raw.ret1InLowDvol',
  'raw.ret1InPosGammaFlow',
  'raw.ret1InNegGammaFlow',
  // Exploration columns (calendar deviations and diagnostic splits), Task
  // 2b, 2026-09-28. See the "EXPLORATION COLUMNS" paragraph above.
  'raw.hourOfDayDriftDev',
  'raw.weekdayDriftDev',
  'raw.ret1InAsia',
  'raw.ret1InNyOverlap',
  'raw.ret1NearRound',
  'raw.ret1FarRound',
  'raw.ret1AfterDown',
  'raw.ret1AfterUp',
  'raw.ret1InHighVolRatio',
  'raw.ret1InLowVolRatio',
  // QH-flow columns (2026-10-09), appended last so every column above keeps
  // its index. Definitions: scripts/research/qh-flow.ts (locked).
  'raw.qhOpenImb',
  'raw.fiveMinOpenImb',
  'raw.largeTakerImb',
  'raw.smallTakerImb',
] as const;

/**
 * The five market-wide options columns: identical across every symbol at a
 * bar by construction, since `marketOptions` is always BTC's file. Exported
 * so factor-ic.ts can drop them from the cross-sectional pass with the same
 * "no cross-sectional content" reason it already applies to raw.btcLeadLag
 * (scripts/research/cross-symbol-factors.ts's CROSS_SYMBOL_NAMES).
 */
export const MARKET_OPTIONS_NAMES = [
  'raw.mktDvolZ30',
  'raw.mktOptDeltaFlow24Z',
  'raw.mktOptGammaFlow24Z',
  'raw.mktOptPutCallVol24',
  'raw.mktOptSkew24',
] as const;

/**
 * The eight exploration diagnostics (Task 2b, 2026-09-28): masks of raw.ret1,
 * never standalone signals, read as the gap between the two subset ICs in
 * the S0 triage record (see the "EXPLORATION COLUMNS" header paragraph).
 * raw.hourOfDayDriftDev and raw.weekdayDriftDev are deviations, not masks of
 * raw.ret1, and are not included here.
 */
export const EXPLORATION_DIAGNOSTIC_NAMES = [
  'raw.ret1InAsia',
  'raw.ret1InNyOverlap',
  'raw.ret1NearRound',
  'raw.ret1FarRound',
  'raw.ret1AfterDown',
  'raw.ret1AfterUp',
  'raw.ret1InHighVolRatio',
  'raw.ret1InLowVolRatio',
] as const;

/**
 * Trailing window for the funding z-score, in days rather than bars.
 *
 * Funding settles every 8h, so a bar-count window degenerates at fine
 * intervals: 96 bars at 5m is a single funding period, over which the
 * standard deviation is zero or near it. Thirty days spans about ninety
 * settlements at every interval.
 */
export const FUNDING_Z_DAYS = 30;
/** Finite readings needed before a z-score is emitted rather than NaN. */
export const FUNDING_Z_MIN_SAMPLES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Days of history the time-of-day and session drifts average over, and the readings a bucket needs. */
export const SEASONAL_DRIFT_DAYS = 60;
export const SEASONAL_DRIFT_MIN_SAMPLES = 20;
/** Days in the trailing z of absolute taker imbalance that splits ret1 by intensity. */
export const TAKER_INTENSITY_DAYS = 30;
/** Days and readings for the within-symbol z of log book notional. */
export const DEPTH_NOTIONAL_Z_DAYS = 30;
export const DEPTH_NOTIONAL_Z_MIN_SAMPLES = 30;
/** Hourly rows summed for the options flow columns (deltaFlow24, gammaFlow24, putCallVol24, skew24). */
export const OPTIONS_FLOW_WINDOW_HOURS = 24;
/** Days of history the DVOL tercile diagnostic (raw.ret1InHighDvol/InLowDvol) classifies against. */
export const DVOL_TERCILE_DAYS = 90;

// trailingZScore lives in src/lib/stats/trailing-z.ts since 2026-10-01 (the live
// scorer needs it too); re-exported so every research import is unchanged.
export { trailingZScore };

/**
 * Trailing mean of `series` over EARLIER bars sharing the bar's bucket (time
 * of day, session), inside a window of `windowBars` bars and excluding the
 * bar itself, so the column carries no term of the bar's own return. NaN
 * until the bucket holds `minSamples` finite readings inside the window.
 *
 * One FIFO of bar indices per bucket with a running sum, so the cost is one
 * pass: a per-bar recompute over a 60-day window at 15m would be quadratic.
 */
export function seasonalDriftSeries(
  series: Float64Array,
  bucketOf: (bar: number) => number,
  windowBars: number,
  minSamples: number
): Float64Array {
  const n = series.length;
  const out = new Float64Array(n).fill(NaN);
  const queues = new Map<number, { bars: number[]; head: number; sum: number }>();

  for (let bar = 0; bar < n; bar++) {
    const bucket = bucketOf(bar);
    let q = queues.get(bucket);
    if (!q) {
      q = { bars: [], head: 0, sum: 0 };
      queues.set(bucket, q);
    }
    while (q.head < q.bars.length && q.bars[q.head] < bar - windowBars) {
      q.sum -= series[q.bars[q.head]];
      q.head++;
    }
    const count = q.bars.length - q.head;
    if (count >= minSamples) out[bar] = q.sum / count;

    const v = series[bar];
    if (Number.isFinite(v)) {
      q.bars.push(bar);
      q.sum += v;
    }
  }
  return out;
}

/** Index rows by timestamp for an exact-bar join, never carrying a stale bar forward. */
function byTimestamp<T extends { t: number }>(rows: T[] | null | undefined): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows ?? []) map.set(row.t, row);
  return map;
}

/** Log change of a per-bar series over `lookback` bars, NaN unless both ends are positive. */
function logChange(series: Float64Array, bar: number, lookback: number): number {
  if (bar < lookback) return NaN;
  const now = series[bar];
  const then = series[bar - lookback];
  if (!Number.isFinite(now) || !Number.isFinite(then) || now <= 0 || then <= 0) return NaN;
  return Math.log(now / then);
}

/** Trailing observations the variance ratio is measured over. */
const VR_WINDOW_BARS = 120;

/** Aggregation period q in VR(q). Four bars, so the ratio is sensitive to
 * reversal over roughly the horizons the program's reversal factors act on. */
const VR_Q = 4;

/**
 * Lo and MacKinlay's variance ratio, VR(q) = Var(r_q) / (q * Var(r_1)), over a
 * trailing window.
 *
 * A random walk has independent increments, so the variance of a q-bar return
 * is q times the variance of a one-bar return and the ratio is 1. Above 1 the
 * series trends, because moves persist and compound; below 1 it mean-reverts,
 * because moves partly cancel. It is a REGIME reading rather than a direction,
 * which is a role nothing else here fills: the program's strongest recorded
 * finding is that mean reversion dominates intraday while momentum survives at
 * 4h, and nothing measures which of the two is in force at a given bar.
 *
 * The simple ratio, not Lo and MacKinlay's bias-corrected estimator. The
 * correction matters for testing the null VR = 1; it does not matter for a
 * monotone regime indicator, which is all this is used as.
 *
 * Running sums, so the cost is one pass regardless of window size, the same
 * reason trailingZScore is written that way.
 */
function varianceRatioSeries(candles: CandleRow[], window: number, q: number): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);

  const r1 = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].c;
    const now = candles[i].c;
    if (prev > 0 && now > 0) r1[i] = Math.log(now / prev);
  }
  const rq = new Float64Array(n).fill(NaN);
  for (let i = q; i < n; i++) {
    const prev = candles[i - q].c;
    const now = candles[i].c;
    if (prev > 0 && now > 0) rq[i] = Math.log(now / prev);
  }

  let sum1 = 0;
  let sumSq1 = 0;
  let count1 = 0;
  let sumQ = 0;
  let sumSqQ = 0;
  let countQ = 0;

  for (let bar = 0; bar < n; bar++) {
    const entering1 = r1[bar];
    if (Number.isFinite(entering1)) {
      sum1 += entering1;
      sumSq1 += entering1 * entering1;
      count1++;
    }
    const enteringQ = rq[bar];
    if (Number.isFinite(enteringQ)) {
      sumQ += enteringQ;
      sumSqQ += enteringQ * enteringQ;
      countQ++;
    }

    const leaving = bar - window;
    if (leaving >= 0) {
      const leaving1 = r1[leaving];
      if (Number.isFinite(leaving1)) {
        sum1 -= leaving1;
        sumSq1 -= leaving1 * leaving1;
        count1--;
      }
      const leavingQ = rq[leaving];
      if (Number.isFinite(leavingQ)) {
        sumQ -= leavingQ;
        sumSqQ -= leavingQ * leavingQ;
        countQ--;
      }
    }

    // A full window of both series must exist before the ratio means anything.
    if (bar < window + q || count1 < 2 || countQ < 2) continue;

    const mean1 = sum1 / count1;
    const variance1 = sumSq1 / count1 - mean1 * mean1;
    if (!(variance1 > 0)) continue;
    const meanQ = sumQ / countQ;
    const varianceQ = Math.max(0, sumSqQ / countQ - meanQ * meanQ);

    out[bar] = varianceQ / (q * variance1);
  }

  return out;
}

/**
 * Change in signed book depth over one bar, scaled by current depth.
 *
 * The banded analogue of order-flow imbalance (Cont, Kukanov and Stoikov 2014),
 * whose result is that price changes are approximately linear in flow scaled by
 * depth. True OFI needs best-quote updates, which do not exist for UM futures
 * (`bookTicker` serves no files), so this is explicitly a banded proxy.
 *
 * No reconstruction of each side is needed. With `N` the notional on both sides
 * and `I` the imbalance, `bid - ask = N * I` identically, so
 * `(B_t - B_{t-1}) - (A_t - A_{t-1})` collapses to `N_t*I_t - N_{t-1}*I_{t-1}`.
 *
 * One documented approximation: `depthNotional1` and `depthImbalance1` are each
 * a mean over the 5m slot's snapshots, so their product is not the mean of the
 * product unless the sum and the ratio are uncorrelated within the slot.
 * `depthSamples` records the snapshot count if that ever needs auditing.
 */
function depthFlow(signed: Float64Array, notional: Float64Array, bar: number): number {
  if (bar < 1) return NaN;
  const now = signed[bar];
  const then = signed[bar - 1];
  const scale = notional[bar];
  if (!Number.isFinite(now) || !Number.isFinite(then) || !Number.isFinite(scale) || scale <= 0) {
    return NaN;
  }
  return (now - then) / scale;
}

/** -1, 0 or 1; NaN propagates so a missing input never reads as "no divergence". */
function signOf(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  return Math.sign(value);
}

function simpleReturn(candles: CandleRow[], bar: number, lookback: number): number {
  if (bar < lookback) return NaN;
  const prev = candles[bar - lookback].c;
  return (candles[bar].c - prev) / prev;
}

function realizedVol20(candles: CandleRow[], bar: number): number {
  if (bar < 20) return NaN;
  const logReturns: number[] = [];
  for (let k = bar - 19; k <= bar; k++) {
    logReturns.push(Math.log(candles[k].c / candles[k - 1].c));
  }
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Ratio of two trailing sample standard deviations (ddof 1) of log returns:
 * `shortWindow` bars over `longWindow` bars, both ending at (and including)
 * each bar. Below 1 the recent short window has been quieter than the
 * longer one behind it; above 1 louder. Feeds raw.ret1InHighVolRatio /
 * raw.ret1InLowVolRatio (see the "EXPLORATION COLUMNS" header paragraph) --
 * a ratio of realised volatility to its own recent history, distinct from
 * raw.varianceRatio's Lo-MacKinlay trend/reversion regime reading.
 *
 * Running sums, so the cost is one pass regardless of window size, the same
 * reason trailingZScore and varianceRatioSeries are written that way. NaN
 * until `longWindow` bars have been seen (since longWindow > shortWindow by
 * construction here, the short window is already full by then too) and
 * whenever either window's sample count is below 2, the minimum for a ddof-1
 * variance to be defined -- the mechanism that makes the column NaN at 1d
 * without a separate interval gate: hoursToBars(24) is a single bar there.
 */
function volRatioSeries(candles: CandleRow[], shortWindow: number, longWindow: number): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);

  const logRet = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].c;
    const now = candles[i].c;
    if (prev > 0 && now > 0) logRet[i] = Math.log(now / prev);
  }

  let sumS = 0;
  let sumSqS = 0;
  let countS = 0;
  let sumL = 0;
  let sumSqL = 0;
  let countL = 0;

  for (let bar = 0; bar < n; bar++) {
    const entering = logRet[bar];
    if (Number.isFinite(entering)) {
      sumS += entering;
      sumSqS += entering * entering;
      countS++;
      sumL += entering;
      sumSqL += entering * entering;
      countL++;
    }

    const leavingS = bar - shortWindow;
    if (leavingS >= 0) {
      const v = logRet[leavingS];
      if (Number.isFinite(v)) {
        sumS -= v;
        sumSqS -= v * v;
        countS--;
      }
    }
    const leavingL = bar - longWindow;
    if (leavingL >= 0) {
      const v = logRet[leavingL];
      if (Number.isFinite(v)) {
        sumL -= v;
        sumSqL -= v * v;
        countL--;
      }
    }

    if (bar < longWindow || countS < 2 || countL < 2) continue;

    const meanS = sumS / countS;
    const varianceS = (sumSqS - countS * meanS * meanS) / (countS - 1);
    const meanL = sumL / countL;
    const varianceL = (sumSqL - countL * meanL * meanL) / (countL - 1);
    if (!(varianceS >= 0) || !(varianceL > 0)) continue;

    out[bar] = Math.sqrt(varianceS) / Math.sqrt(varianceL);
  }

  return out;
}

/**
 * A trailing 24-row sum of `value(row)` over the `OPTIONS_FLOW_WINDOW_HOURS`
 * hourly rows ending at (and including) each row, requiring every one of
 * those hours to be present at an exact hourly spacing and to carry a finite
 * value. A missing hour (a gap in `rows` itself) or a null/non-finite value
 * anywhere in the window makes that bar's sum NaN rather than a partial
 * total -- `deltaFlow24` and `gammaFlow24` are FLOWS, and a flow with an
 * unknown hour inside it is not a smaller flow, it is an unknown one.
 *
 * `rows` must be sorted ascending by `t`, the same assumption every other
 * loader in this file makes of its input rows.
 */
function trailingConsecutiveSum(
  rows: OptionsRow[],
  value: (row: OptionsRow) => number | null
): Float64Array {
  const n = rows.length;
  const out = new Float64Array(n).fill(NaN);

  for (let i = OPTIONS_FLOW_WINDOW_HOURS - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    let expectedT = rows[i].t;
    for (let k = i; k > i - OPTIONS_FLOW_WINDOW_HOURS; k--) {
      if (rows[k].t !== expectedT) {
        ok = false;
        break;
      }
      const v = value(rows[k]);
      if (v === null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
      expectedT -= OPTIONS_SLOT_MS;
    }
    if (ok) out[i] = sum;
  }

  return out;
}

/**
 * Like `trailingConsecutiveSum`, but a MEAN rather than a sum, and tolerant
 * of an individual hour's `value(row)` being non-finite: only the hours that
 * clear the fixed-spacing (no missing-hour) gate contribute their finite
 * value, and the mean is taken over however many of the 24 turn out finite
 * (NaN if none do). Used for `skew24`, which is already an average of a
 * difference rather than a summed flow, so a thin-quoted hour inside an
 * otherwise gap-free window thins the average instead of poisoning it.
 */
function trailingConsecutiveMean(
  rows: OptionsRow[],
  value: (row: OptionsRow) => number
): Float64Array {
  const n = rows.length;
  const out = new Float64Array(n).fill(NaN);

  for (let i = OPTIONS_FLOW_WINDOW_HOURS - 1; i < n; i++) {
    let expectedT = rows[i].t;
    let gapFree = true;
    let sum = 0;
    let count = 0;
    for (let k = i; k > i - OPTIONS_FLOW_WINDOW_HOURS; k--) {
      if (rows[k].t !== expectedT) {
        gapFree = false;
        break;
      }
      const v = value(rows[k]);
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
      expectedT -= OPTIONS_SLOT_MS;
    }
    if (gapFree && count > 0) out[i] = sum / count;
  }

  return out;
}

/** Finite putIv25 minus callIv25 for one hourly row, NaN when either leg is null. */
function ivSkewOf(row: OptionsRow): number {
  if (row.putIv25 === null || row.callIv25 === null) return NaN;
  if (!Number.isFinite(row.putIv25) || !Number.isFinite(row.callIv25)) return NaN;
  return row.putIv25 - row.callIv25;
}

/** The five per-bar series `computeFactorMatrix` joins from an OptionsRow[], aligned onto the caller's bar grid. */
interface OptionsAligned {
  dvolClose: Float64Array;
  deltaFlow24: Float64Array;
  gammaFlow24: Float64Array;
  putCallVol24: Float64Array;
  skew24: Float64Array;
}

/**
 * Precomputes `deltaFlow24`, `gammaFlow24`, `putCallVol24` and `skew24` on
 * the hourly rows (see this file's "OPTIONS INPUTS" header paragraph), then
 * joins all five series (dvolClose included) onto `barCloses` by the join
 * rule every archive input in this file uses: a row is observable only from
 * its own close onward (`row.t + OPTIONS_SLOT_MS - 1`), and a bar more than
 * `Math.max(intervalMs, 2 * OPTIONS_SLOT_MS)` past the last observable row
 * reads NaN rather than a stale carry-forward.
 *
 * `rows` null, missing or empty yields every series NaN throughout, the same
 * "absent input, NaN column" rule every optional input in this file follows.
 */
function alignOptionsToBars(
  rows: OptionsRow[] | null | undefined,
  barCloses: number[],
  intervalMs: number
): OptionsAligned {
  const n = barCloses.length;
  const empty: OptionsAligned = {
    dvolClose: new Float64Array(n).fill(NaN),
    deltaFlow24: new Float64Array(n).fill(NaN),
    gammaFlow24: new Float64Array(n).fill(NaN),
    putCallVol24: new Float64Array(n).fill(NaN),
    skew24: new Float64Array(n).fill(NaN),
  };
  if (!rows || rows.length === 0) return empty;

  const deltaSum = trailingConsecutiveSum(rows, (r) => r.netDelta);
  const gammaSum = trailingConsecutiveSum(rows, (r) => r.netDollarGamma);
  const putBuySum = trailingConsecutiveSum(rows, (r) => r.putBuyNotional);
  const putSellSum = trailingConsecutiveSum(rows, (r) => r.putSellNotional);
  const callBuySum = trailingConsecutiveSum(rows, (r) => r.callBuyNotional);
  const callSellSum = trailingConsecutiveSum(rows, (r) => r.callSellNotional);
  const skewMean = trailingConsecutiveMean(rows, ivSkewOf);

  interface Joined {
    timestamp: number;
    dvolClose: number;
    deltaFlow24: number;
    gammaFlow24: number;
    putCallVol24: number;
    skew24: number;
  }

  const joined: Joined[] = rows.map((row, i) => {
    const putSum = putBuySum[i] + putSellSum[i];
    const callSum = callBuySum[i] + callSellSum[i];
    const putCallVol24 =
      Number.isFinite(putSum) && Number.isFinite(callSum) && callSum !== 0 ? putSum / callSum : NaN;

    return {
      timestamp: row.t + OPTIONS_SLOT_MS - 1,
      dvolClose: row.dvolClose ?? NaN,
      deltaFlow24: deltaSum[i],
      gammaFlow24: gammaSum[i],
      putCallVol24,
      skew24: skewMean[i],
    };
  });

  const staleness = Math.max(intervalMs, 2 * OPTIONS_SLOT_MS);
  const aligned = alignToBars(barCloses, joined, staleness);

  const out: OptionsAligned = {
    dvolClose: new Float64Array(n).fill(NaN),
    deltaFlow24: new Float64Array(n).fill(NaN),
    gammaFlow24: new Float64Array(n).fill(NaN),
    putCallVol24: new Float64Array(n).fill(NaN),
    skew24: new Float64Array(n).fill(NaN),
  };
  for (let bar = 0; bar < n; bar++) {
    const a = aligned[bar];
    if (!a) continue;
    out.dvolClose[bar] = a.dvolClose;
    out.deltaFlow24[bar] = a.deltaFlow24;
    out.gammaFlow24[bar] = a.gammaFlow24;
    out.putCallVol24[bar] = a.putCallVol24;
    out.skew24[bar] = a.skew24;
  }
  return out;
}

/**
 * Classifies each bar's value against the top/bottom tercile of a trailing
 * window of `windowBars` bars (the bar's own value included in its own
 * window, the same inclusion rule `trailingZScore` uses), among however many
 * of those bars carry a finite value. NaN (neither high nor low) before
 * `minSamples` finite readings have accumulated, on a non-finite bar itself,
 * and on the middle third of the window. Ties are broken by rank, so there
 * is no separate "exactly at the cut" case.
 *
 * Sorts the window's finite values on every qualifying bar: a quantile
 * boundary, unlike a mean or a variance, cannot be maintained with a running
 * sum the way `trailingZScore` maintains its. Fine for a diagnostic measured
 * once per research run, not a hot path.
 */
function trailingTercileMask(
  series: Float64Array,
  windowBars: number,
  minSamples: number
): { high: Uint8Array; low: Uint8Array } {
  const n = series.length;
  const high = new Uint8Array(n);
  const low = new Uint8Array(n);
  const values: number[] = [];
  const enteredAt: number[] = [];
  let head = 0;

  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (Number.isFinite(v)) {
      values.push(v);
      enteredAt.push(i);
    }
    while (head < enteredAt.length && enteredAt[head] <= i - windowBars) head++;

    const count = values.length - head;
    if (!Number.isFinite(v) || count < minSamples) continue;

    const window = values.slice(head).sort((a, b) => a - b);
    let rank = 0;
    while (rank < window.length && window[rank] < v) rank++;

    const lowerCut = Math.floor(count / 3);
    const upperCut = count - Math.floor(count / 3);
    if (rank < lowerCut) low[i] = 1;
    else if (rank >= upperCut) high[i] = 1;
  }

  return { high, low };
}

/**
 * Whether a category has no real input to score, matching what actually
 * determines `component.score` rather than the displayed `signals` list.
 * scoreVolatility (src/lib/signals/scorer.ts) excludes ATR -- a volatility
 * regime reading, not a directional signal -- from the score it computes,
 * but still lists ATR in `signals`, so volatility needs the same exclusion
 * here or a bar with only ATR would read as "has data" when it has none.
 */
function isCategoryDataMissing(component: SignalComponent): boolean {
  if (component.category === 'volatility') {
    return component.signals.filter((s) => s.name !== 'ATR').length === 0;
  }
  return component.signals.length === 0;
}

const FLOW_BUCKET_MS = 5 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

/** Signed quote over total quote, NaN on a zero (or non-finite) denominator. */
function signedShare(signed: number, total: number): number {
  return total > 0 && Number.isFinite(total) ? signed / total : NaN;
}

/**
 * The four qh-flow readings for the bar [openT, openT + intervalMs), in the
 * order qhOpenImb, fiveMinOpenImb, largeTakerImb, smallTakerImb. All NaN when
 * any of the bar's intervalMs / 5 minutes buckets is absent, or when the
 * quarter-hour, other-mark or total denominator is not positive.
 */
function flowColumns(
  byBucket: Map<number, FlowRow>,
  openT: number,
  intervalMs: number
): [number, number, number, number] {
  const expected = intervalMs / FLOW_BUCKET_MS;
  if (!Number.isInteger(expected)) return [NaN, NaN, NaN, NaN];

  let qhDiff = 0;
  let qhTotal = 0;
  let fiveDiff = 0;
  let fiveTotal = 0;
  let largeDiff = 0;
  let smallDiff = 0;
  let total = 0;

  for (let i = 0; i < expected; i++) {
    const t = openT + i * FLOW_BUCKET_MS;
    const row = byBucket.get(t);
    if (!row) return [NaN, NaN, NaN, NaN];
    const diff = row.buyQuoteOpen10s - row.sellQuoteOpen10s;
    const sum = row.buyQuoteOpen10s + row.sellQuoteOpen10s;
    if (t % QUARTER_HOUR_MS === 0) {
      qhDiff += diff;
      qhTotal += sum;
    } else {
      fiveDiff += diff;
      fiveTotal += sum;
    }
    largeDiff += row.buyQuoteLarge - row.sellQuoteLarge;
    smallDiff += row.buyQuoteSmall - row.sellQuoteSmall;
    total += row.buyQuote + row.sellQuote;
  }

  // Locked COLUMNS rule: a zero denominator in ANY of the three nulls all four columns.
  const usable = (d: number): boolean => d > 0 && Number.isFinite(d);
  if (!usable(qhTotal) || !usable(fiveTotal) || !usable(total)) return [NaN, NaN, NaN, NaN];

  return [
    signedShare(qhDiff, qhTotal),
    signedShare(fiveDiff, fiveTotal),
    signedShare(largeDiff, total),
    signedShare(smallDiff, total),
  ];
}

export function computeFactorMatrix(input: FactorMatrixInput): FactorMatrix {
  const { candles, snapshots, htf, interval, metrics, perp, premiumIndex, options, marketOptions, flow } = input;
  const style = input.style ?? styleForInterval(interval);
  const profile = getStyleConfig(style);
  const weights = DEFAULT_TEMPLATE_WEIGHTS[style];

  // htf must be index-aligned with candles (one row per candle, same
  // timestamp) -- everything below reads htf[bar] positionally assuming
  // that invariant. A silent misalignment would attribute the wrong HTF
  // context to a bar without any error, so it is checked here rather than
  // trusted from the caller.
  if (htf.length !== candles.length) {
    throw new Error(
      `computeFactorMatrix: htf has ${htf.length} rows but candles has ${candles.length}`
    );
  }
  for (let i = 0; i < candles.length; i++) {
    if (htf[i].t !== candles[i].t) {
      throw new Error(
        `computeFactorMatrix: htf[${i}].t (${htf[i].t}) does not match candles[${i}].t (${candles[i].t})`
      );
    }
  }

  const ohlcv = candles.map(toOHLCV);
  const leanSnapshots = snapshots ? snapshots.map(toLeanSnapshot) : undefined;
  const leanLsRows1h = input.lsRows1h ? input.lsRows1h.map(toLeanSnapshot) : undefined;

  // No htfInput: HTF context is already precomputed per bar in `htf` (C1's export),
  // computed the same causal way (computeHtfSeries + alignHtfToLtf + htfContextAtBar).
  const prepared = prepareBacktest(ohlcv, '', interval, profile.config, leanSnapshots, undefined, undefined, leanLsRows1h);
  const { indicators, superTrend, warmupBars, stOffset, snapshots: alignedSnapshots } = prepared;

  const n = candles.length;

  // One composite per bar, exactly as the optimized engine scores a bar --
  // same suite, snapshot inputs, SuperTrend, and HTF context -- but with the
  // style's DEFAULT_TEMPLATE_WEIGHTS rather than a BacktestConfig's weights.
  // Bars before warmupBars are never read below (every consumer starts its
  // own loop at warmupBars), so scoring them is discarded work skipped here.
  const composites: ReturnType<typeof computeSignalScore>[] = new Array(n);
  for (let bar = warmupBars; bar < n; bar++) {
    const suite = indicators[bar];
    const scoringSuite = style === 'scalping' ? excludeIchimokuForScalping(suite) : suite;
    const snap = alignedSnapshots?.[bar] ?? null;
    const htfCtx = htf[bar]?.context ?? null;

    const stIdx = bar - stOffset;
    const superTrendAtBar = stIdx >= 0 && stIdx < superTrend.length ? superTrend[stIdx] : undefined;

    composites[bar] = computeSignalScore(
      scoringSuite,
      snap?.futures ?? null,
      snap?.sentiment ?? null,
      weights,
      superTrendAtBar ? { values: superTrend, current: superTrendAtBar } : null,
      htfCtx
    );
  }

  // Discover every sig.<name> that fires on any post-warmup bar, in first-seen
  // order (category order, then encounter order within a category). Names
  // that never fire for this style/interval/data combination are simply
  // absent, rather than a column that is NaN for the whole series.
  const sigOrder: string[] = [];
  const sigCategory = new Map<string, string>();
  for (let bar = warmupBars; bar < n; bar++) {
    for (const component of composites[bar].components) {
      for (const sig of component.signals) {
        if (!sigCategory.has(sig.name)) {
          sigCategory.set(sig.name, component.category);
          sigOrder.push(sig.name);
        }
      }
    }
  }

  const names: string[] = [
    'composite',
    ...CATEGORY_ORDER.map((c) => `cat.${c}`),
    ...sigOrder.map((s) => `sig.${s}`),
    ...RAW_NAMES,
  ];
  const categories: string[] = [
    'composite',
    ...CATEGORY_ORDER,
    ...sigOrder.map((s) => sigCategory.get(s)!),
    ...RAW_NAMES.map(() => 'raw'),
  ];

  const values: Float64Array[] = names.map(() => new Float64Array(n).fill(NaN));
  const nameIndex = new Map<string, number>(names.map((name, i) => [name, i]));

  const compositeIdx = nameIndex.get('composite')!;
  const catIdx = new Map(CATEGORY_ORDER.map((c) => [c, nameIndex.get(`cat.${c}`)!]));
  const sigIdx = new Map(sigOrder.map((s) => [s, nameIndex.get(`sig.${s}`)!]));
  const rawIdx = new Map(RAW_NAMES.map((r) => [r, nameIndex.get(r)!]));

  // Archive inputs, aligned to these bars.
  //
  // The metrics grid is 5m native, so it is joined with the last reading at or
  // before each bar's CLOSE, not its open. A factor is read at the bar's close
  // (forwardReturns measures from closes[bar] onward), so a reading from
  // inside the bar is already published by the time the factor is used, and
  // taking the open instead would throw away most of an hour of information at
  // 1h. This is deliberately not the rule src/lib/backtest/snapshot-series.ts
  // applies to HistoricalSnapshot rows, which is pinned to the bar's open
  // because live snapshot ingestion runs on its own cron.
  const intervalMs = intervalToMs(interval);
  const barCloses = candles.map((candle) => candle.t + intervalMs - 1);
  const metricsStaleness = Math.max(intervalMs, 2 * METRICS_SLOT_MS);
  const alignedMetrics = metrics && metrics.length > 0
    ? alignToBars(barCloses, metrics.map((row) => ({ ...row, timestamp: row.t })), metricsStaleness)
    : null;

  // qh-flow buckets, keyed by bucket open for the per-bar window lookup.
  const flowByBucket = new Map<number, FlowRow>();
  for (const row of flow ?? []) flowByBucket.set(row.t, row);

  // Perpetual bars share the candle grid, so they join on an exact timestamp
  // match: a missing perp bar is NaN, never the previous bar's price.
  const perpByTime = byTimestamp(perp);
  const premiumByTime = byTimestamp(premiumIndex);

  // Open interest per bar, needed as a series before its changes can be taken.
  const openInterestSeries = new Float64Array(n).fill(NaN);
  if (alignedMetrics) {
    for (let bar = 0; bar < n; bar++) {
      openInterestSeries[bar] = alignedMetrics[bar]?.openInterest ?? NaN;
    }
  }

  // Book depth per bar, needed as series before a change can be taken. `signed`
  // is bid minus ask, which is the notional times the imbalance.
  const depthNotionalSeries = new Float64Array(n).fill(NaN);
  const signedDepthSeries = new Float64Array(n).fill(NaN);
  if (alignedMetrics) {
    for (let bar = 0; bar < n; bar++) {
      const notional = alignedMetrics[bar]?.depthNotional1;
      const imbalance = alignedMetrics[bar]?.depthImbalance1;
      if (typeof notional === 'number' && Number.isFinite(notional)) {
        depthNotionalSeries[bar] = notional;
        if (typeof imbalance === 'number' && Number.isFinite(imbalance)) {
          signedDepthSeries[bar] = notional * imbalance;
        }
      }
    }
  }

  const varianceRatio = varianceRatioSeries(candles, VR_WINDOW_BARS, VR_Q);

  const fundingSeries = new Float64Array(n).fill(NaN);
  for (let bar = warmupBars; bar < n; bar++) {
    fundingSeries[bar] = alignedSnapshots?.[bar]?.futures?.fundingRate?.fundingRate ?? NaN;
  }
  const fundingZ = trailingZScore(
    fundingSeries,
    Math.max(1, Math.ceil((FUNDING_Z_DAYS * DAY_MS) / intervalMs)),
    FUNDING_Z_MIN_SAMPLES
  );

  const daysToBars = (days: number) => Math.max(1, Math.ceil((days * DAY_MS) / intervalMs));

  const ret1Series = new Float64Array(n).fill(NaN);
  for (let bar = 0; bar < n; bar++) ret1Series[bar] = simpleReturn(candles, bar, 1);

  // Time of day as a bucket index: 96 quarter-hours at 15m, 24 at 1h, 6 at 4h.
  // At 1d (and coarser) every bar falls in the one bucket, so the column would
  // be a trailing 60-day mean return with no time-of-day content at all. NaN
  // throughout there, the same way sessionDrift is NaN off-session, rather than
  // a differently-named momentum column.
  const hourOfDayDrift =
    DAY_MS / intervalMs > 1
      ? seasonalDriftSeries(
          ret1Series,
          (bar) => Math.floor((candles[bar].t % DAY_MS) / intervalMs),
          daysToBars(SEASONAL_DRIFT_DAYS),
          SEASONAL_DRIFT_MIN_SAMPLES
        )
      : new Float64Array(n).fill(NaN);
  const sessionDrift = isSessionMeaningful(interval)
    ? seasonalDriftSeries(
        ret1Series,
        (bar) => MARKET_SESSIONS.indexOf(sessionOfCandleClose(candles[bar].t, intervalMs)),
        daysToBars(SEASONAL_DRIFT_DAYS),
        SEASONAL_DRIFT_MIN_SAMPLES
      )
    : new Float64Array(n).fill(NaN);

  // Exploration deviations (see the "EXPLORATION COLUMNS" header paragraph).
  // The unconditional trailing mean is the SAME seasonalDriftSeries call with
  // a single, constant bucket, so it excludes the bar itself exactly like
  // hourOfDayDrift and weekdayDrift do -- subtracting it removes the slow
  // trailing-mean reversal both bucketed columns were found to carry.
  const unconditionalDrift = seasonalDriftSeries(
    ret1Series,
    () => 0,
    daysToBars(SEASONAL_DRIFT_DAYS),
    SEASONAL_DRIFT_MIN_SAMPLES
  );
  // Day of week (UTC), 7 buckets. Unlike hourOfDayDrift, no interval-level
  // gate: at 1d each bucket holds about 8 readings in 60 days, below
  // SEASONAL_DRIFT_MIN_SAMPLES, so seasonalDriftSeries's own threshold
  // already yields NaN there without a special case.
  const weekdayDrift = seasonalDriftSeries(
    ret1Series,
    (bar) => new Date(candles[bar].t).getUTCDay(),
    daysToBars(SEASONAL_DRIFT_DAYS),
    SEASONAL_DRIFT_MIN_SAMPLES
  );

  // Realised-vol ratio for raw.ret1InHighVolRatio/InLowVolRatio (see the
  // "EXPLORATION COLUMNS" header paragraph and volRatioSeries above).
  const hoursToBars = (hours: number) => Math.max(1, Math.round((hours * 60 * 60 * 1000) / intervalMs));
  const volRatio = volRatioSeries(candles, hoursToBars(24), hoursToBars(168));

  // Matches fundingSeries above: only counted from warmupBars, so a state
  // variable available since bar 0 in the raw archive does not make the
  // z-score's own ramp-up (minSamples readings) invisible by borrowing
  // pre-warmup history nothing else here reads either.
  const logNotional = new Float64Array(n).fill(NaN);
  for (let bar = warmupBars; bar < n; bar++) {
    const v = depthNotionalSeries[bar];
    if (Number.isFinite(v) && v > 0) logNotional[bar] = Math.log(v);
  }
  const depthNotionalZ = trailingZScore(logNotional, daysToBars(DEPTH_NOTIONAL_Z_DAYS), DEPTH_NOTIONAL_Z_MIN_SAMPLES);

  const takerIntensity = new Float64Array(n).fill(NaN);
  for (let bar = 0; bar < n; bar++) {
    const c = candles[bar];
    if (c.tbv !== null && c.v > 0) takerIntensity[bar] = Math.abs((2 * c.tbv) / c.v - 1);
  }
  const takerIntensityZ = trailingZScore(takerIntensity, daysToBars(TAKER_INTENSITY_DAYS), FUNDING_Z_MIN_SAMPLES);

  // Options inputs (see the "OPTIONS INPUTS" header paragraph). `own` reads
  // this symbol's own currency file, `market` always reads BTC's, joined the
  // same way for every symbol.
  const ownOptions = alignOptionsToBars(options, barCloses, intervalMs);
  const marketOptionsAligned = alignOptionsToBars(marketOptions, barCloses, intervalMs);

  // Matches fundingSeries/logNotional above: masked to NaN before warmupBars,
  // so a reading available since bar 0 does not let the z-score's own
  // ramp-up borrow pre-warmup history nothing else here reads either. The
  // masked series also feeds the two diagnostics below directly (unscored
  // levels, not z-scores).
  const maskFromWarmup = (series: Float64Array): Float64Array => {
    const out = new Float64Array(n).fill(NaN);
    for (let bar = warmupBars; bar < n; bar++) out[bar] = series[bar];
    return out;
  };

  const ownDvolMasked = maskFromWarmup(ownOptions.dvolClose);
  const ownDeltaFlow24Masked = maskFromWarmup(ownOptions.deltaFlow24);
  const ownGammaFlow24Masked = maskFromWarmup(ownOptions.gammaFlow24);
  const mktDvolMasked = maskFromWarmup(marketOptionsAligned.dvolClose);
  const mktDeltaFlow24Masked = maskFromWarmup(marketOptionsAligned.deltaFlow24);
  const mktGammaFlow24Masked = maskFromWarmup(marketOptionsAligned.gammaFlow24);

  // Same helper and constants raw.depthNotionalZ uses (both windows happen
  // to be 30 days / 30 samples today, but this traces to the constant the
  // brief actually named rather than the funding z-score's, which is only
  // equal by coincidence).
  const optionsZWindow = daysToBars(DEPTH_NOTIONAL_Z_DAYS);
  const ownDvolZ30 = trailingZScore(ownDvolMasked, optionsZWindow, DEPTH_NOTIONAL_Z_MIN_SAMPLES);
  const ownOptDeltaFlow24Z = trailingZScore(ownDeltaFlow24Masked, optionsZWindow, DEPTH_NOTIONAL_Z_MIN_SAMPLES);
  const ownOptGammaFlow24Z = trailingZScore(ownGammaFlow24Masked, optionsZWindow, DEPTH_NOTIONAL_Z_MIN_SAMPLES);
  const mktDvolZ30 = trailingZScore(mktDvolMasked, optionsZWindow, DEPTH_NOTIONAL_Z_MIN_SAMPLES);
  const mktOptDeltaFlow24Z = trailingZScore(mktDeltaFlow24Masked, optionsZWindow, DEPTH_NOTIONAL_Z_MIN_SAMPLES);
  const mktOptGammaFlow24Z = trailingZScore(mktGammaFlow24Masked, optionsZWindow, DEPTH_NOTIONAL_Z_MIN_SAMPLES);

  // Diagnostics: masks of raw.ret1 by a market-wide options reading, in the
  // Stage 2 style (raw.ret1InMeanReversion/InTrend above). Never a signal on
  // their own.
  const dvolTercile = trailingTercileMask(mktDvolMasked, daysToBars(DVOL_TERCILE_DAYS), FUNDING_Z_MIN_SAMPLES);

  for (let bar = warmupBars; bar < n; bar++) {
    const composite = composites[bar];
    values[compositeIdx][bar] = composite.score;

    for (const component of composite.components) {
      const idx = catIdx.get(component.category);
      if (idx !== undefined) {
        // Missing input (no futures/sentiment/htf data at this bar) -> NaN,
        // not the scorer's internal 0-for-redistribution default.
        values[idx][bar] = isCategoryDataMissing(component) ? NaN : component.score;
      }

      for (const sig of component.signals) {
        const sIdx = sigIdx.get(sig.name);
        if (sIdx !== undefined) {
          const multiplier = sig.direction === 'bullish' ? 1 : sig.direction === 'bearish' ? -1 : 0;
          values[sIdx][bar] = multiplier * sig.strength;
        }
      }
    }

    const suite = indicators[bar];
    const candle = candles[bar];
    const snap = alignedSnapshots?.[bar] ?? null;
    const htfCtx = htf[bar]?.context ?? null;

    values[rawIdx.get('raw.rsi')!][bar] = suite.rsi.current;
    values[rawIdx.get('raw.emaSpreadPct')!][bar] =
      ((suite.ema12.current - suite.ema26.current) / suite.ema26.current) * 100;
    values[rawIdx.get('raw.atrPct')!][bar] = (suite.atr.current / candle.c) * 100;
    values[rawIdx.get('raw.fundingRate')!][bar] = snap?.futures?.fundingRate?.fundingRate ?? NaN;
    values[rawIdx.get('raw.longShortRatio')!][bar] =
      snap?.futures?.longShortRatio?.longShortRatio ?? NaN;
    values[rawIdx.get('raw.takerBuyRatio')!][bar] =
      candle.tbv !== null && candle.v !== 0 ? candle.tbv / candle.v : NaN;
    values[rawIdx.get('raw.fearGreed')!][bar] = snap?.sentiment?.fearGreedIndex ?? NaN;
    // A null context is a missing input (no confirmation interval, e.g. 1d,
    // or the HTF's own warmup not yet satisfied) -> NaN, distinct from a
    // real 'neutral' trend reading, which is 0.
    values[rawIdx.get('raw.htfTrend')!][bar] = !htfCtx
      ? NaN
      : htfCtx.trendDirection === 'bullish'
        ? 1
        : htfCtx.trendDirection === 'bearish'
          ? -1
          : 0;
    values[rawIdx.get('raw.ret1')!][bar] = simpleReturn(candles, bar, 1);
    values[rawIdx.get('raw.ret5')!][bar] = simpleReturn(candles, bar, 5);
    values[rawIdx.get('raw.ret20')!][bar] = simpleReturn(candles, bar, 20);
    values[rawIdx.get('raw.realizedVol20')!][bar] = realizedVol20(candles, bar);

    if (flowByBucket.size > 0) {
      const [qh, fiveMin, large, small] = flowColumns(flowByBucket, candle.t, intervalMs);
      values[rawIdx.get('raw.qhOpenImb')!][bar] = qh;
      values[rawIdx.get('raw.fiveMinOpenImb')!][bar] = fiveMin;
      values[rawIdx.get('raw.largeTakerImb')!][bar] = large;
      values[rawIdx.get('raw.smallTakerImb')!][bar] = small;
    }

    const metric = alignedMetrics?.[bar] ?? null;
    const oiChange1 = logChange(openInterestSeries, bar, 1);
    values[rawIdx.get('raw.oiChange1')!][bar] = oiChange1;
    values[rawIdx.get('raw.oiChange8')!][bar] = logChange(openInterestSeries, bar, 8);
    // Positions building into a move against positions covering out of one.
    // NaN in either leg propagates, so "no divergence" is never inferred from
    // a missing reading.
    values[rawIdx.get('raw.oiPriceDiv')!][bar] =
      signOf(oiChange1) * signOf(simpleReturn(candles, bar, 1));
    values[rawIdx.get('raw.takerLongShortRatio')!][bar] = metric?.takerLongShortRatio ?? NaN;
    values[rawIdx.get('raw.topTraderPositionRatio')!][bar] = metric?.topTraderPositionRatio ?? NaN;
    values[rawIdx.get('raw.globalAccountRatio')!][bar] = metric?.globalAccountRatio ?? NaN;
    values[rawIdx.get('raw.depthImbalance1')!][bar] = metric?.depthImbalance1 ?? NaN;
    values[rawIdx.get('raw.depthImbalance5')!][bar] = metric?.depthImbalance5 ?? NaN;
    values[rawIdx.get('raw.depthNotional1')!][bar] = metric?.depthNotional1 ?? NaN;
    // How much thicker the book is out at 5% than at 1%: where liquidity sits
    // is a direct expected-slippage reading, and nothing else here measures it.
    const notional1 = metric?.depthNotional1;
    const notional5 = metric?.depthNotional5;
    values[rawIdx.get('raw.depthSlope')!][bar] =
      typeof notional1 === 'number' &&
      typeof notional5 === 'number' &&
      Number.isFinite(notional1) &&
      Number.isFinite(notional5) &&
      notional1 > 0
        ? (notional5 - notional1) / notional1
        : NaN;
    values[rawIdx.get('raw.depthFlow1')!][bar] = depthFlow(
      signedDepthSeries,
      depthNotionalSeries,
      bar
    );

    const vr = varianceRatio[bar];
    values[rawIdx.get('raw.varianceRatio')!][bar] = vr;
    // The same one-bar return, split by the regime the bar sits in. Comparing
    // the two ICs is the actual test of whether the ratio conditions anything:
    // a raw IC of the ratio itself would ask whether the regime predicts
    // direction, which is not the hypothesis.
    const ret1ForRegime = simpleReturn(candles, bar, 1);
    const regimeKnown = Number.isFinite(vr) && Number.isFinite(ret1ForRegime);
    values[rawIdx.get('raw.ret1InMeanReversion')!][bar] =
      regimeKnown && vr < 1 ? ret1ForRegime : NaN;
    values[rawIdx.get('raw.ret1InTrend')!][bar] = regimeKnown && vr >= 1 ? ret1ForRegime : NaN;

    // Funding settles on a known 8h clock, so a bar's distance from the next
    // settlement is an EVENT-time coordinate. Everything else here is measured
    // in clock time or bar count. Weighting the rate by proximity asks whether
    // crowded positioning unwinds into the settlement it is about to pay.
    const fundingNow = snap?.futures?.fundingRate?.fundingRate;
    if (typeof fundingNow === 'number' && Number.isFinite(fundingNow)) {
      const barClose = candle.t + intervalMs - 1;
      const nextSettlement = Math.ceil(barClose / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
      const proximity = 1 - (nextSettlement - barClose) / FUNDING_INTERVAL_MS;
      values[rawIdx.get('raw.fundingProximity')!][bar] = fundingNow * proximity;
    } else {
      values[rawIdx.get('raw.fundingProximity')!][bar] = NaN;
    }

    values[rawIdx.get('raw.hourOfDayDrift')!][bar] = hourOfDayDrift[bar];
    values[rawIdx.get('raw.sessionDrift')!][bar] = sessionDrift[bar];
    values[rawIdx.get('raw.depthNotionalZ')!][bar] = depthNotionalZ[bar];
    // The one-bar return split by taker intensity: the pair is the
    // conditioning test, never a signal on its own (see the pre-registration).
    const r1 = ret1Series[bar];
    const tz = takerIntensityZ[bar];
    const intensityKnown = Number.isFinite(tz) && Number.isFinite(r1);
    values[rawIdx.get('raw.ret1InHighTaker')!][bar] = intensityKnown && tz > 0 ? r1 : NaN;
    values[rawIdx.get('raw.ret1InLowTaker')!][bar] = intensityKnown && tz <= 0 ? r1 : NaN;

    // Exploration columns, 2026-09-28: see the "EXPLORATION COLUMNS" header
    // paragraph. hourOfDayDriftDev/weekdayDriftDev are deviations of the
    // Phase B seasonal columns above; the rest are Stage-2-style diagnostic
    // masks of raw.ret1, never signals on their own.
    values[rawIdx.get('raw.hourOfDayDriftDev')!][bar] =
      Number.isFinite(hourOfDayDrift[bar]) && Number.isFinite(unconditionalDrift[bar])
        ? hourOfDayDrift[bar] - unconditionalDrift[bar]
        : NaN;
    values[rawIdx.get('raw.weekdayDriftDev')!][bar] =
      Number.isFinite(weekdayDrift[bar]) && Number.isFinite(unconditionalDrift[bar])
        ? weekdayDrift[bar] - unconditionalDrift[bar]
        : NaN;

    const sessionMeaningful = isSessionMeaningful(interval);
    const session = sessionMeaningful ? sessionOfCandleClose(candle.t, intervalMs) : null;
    values[rawIdx.get('raw.ret1InAsia')!][bar] = session === 'asia' ? r1 : NaN;
    values[rawIdx.get('raw.ret1InNyOverlap')!][bar] = session === 'ny_overlap' ? r1 : NaN;

    // Nearest two-significant-figure price level: e.g. 60050 -> step 1000,
    // nearest 60000 (0.08% away, "near"); 100.5 -> step 10, nearest 100
    // (0.50% away, "far").
    let nearRound = NaN;
    let farRound = NaN;
    if (candle.c > 0) {
      const step = 10 ** (Math.floor(Math.log10(candle.c)) - 1);
      const nearest = Math.round(candle.c / step) * step;
      const fraction = Math.abs(candle.c - nearest) / candle.c;
      if (fraction <= 0.002) nearRound = r1;
      else farRound = r1;
    }
    values[rawIdx.get('raw.ret1NearRound')!][bar] = nearRound;
    values[rawIdx.get('raw.ret1FarRound')!][bar] = farRound;

    const prevRet = bar >= 1 ? ret1Series[bar - 1] : NaN;
    values[rawIdx.get('raw.ret1AfterDown')!][bar] = Number.isFinite(prevRet) && prevRet < 0 ? r1 : NaN;
    values[rawIdx.get('raw.ret1AfterUp')!][bar] = Number.isFinite(prevRet) && prevRet > 0 ? r1 : NaN;

    const vRatio = volRatio[bar];
    const vRatioKnown = Number.isFinite(vRatio) && Number.isFinite(r1);
    values[rawIdx.get('raw.ret1InHighVolRatio')!][bar] = vRatioKnown && vRatio > 0.7 ? r1 : NaN;
    values[rawIdx.get('raw.ret1InLowVolRatio')!][bar] = vRatioKnown && vRatio <= 0.7 ? r1 : NaN;

    values[rawIdx.get('raw.fundingZ')!][bar] = fundingZ[bar];

    // The premium index close is the perp-to-index premium as a fraction.
    const premiumBar = premiumByTime.get(candle.t);
    values[rawIdx.get('raw.basisPct')!][bar] = premiumBar ? premiumBar.c * 100 : NaN;

    // What the venue mismatch is worth at this bar: candles/ holds SPOT closes
    // while every backtest charges perpetual costs.
    const perpBar = perpByTime.get(candle.t);
    values[rawIdx.get('raw.perpSpotSpreadPct')!][bar] =
      perpBar && candle.c !== 0 ? ((perpBar.c - candle.c) / candle.c) * 100 : NaN;

    // Options inputs: see the "OPTIONS INPUTS" header paragraph.
    values[rawIdx.get('raw.mktDvolZ30')!][bar] = mktDvolZ30[bar];
    values[rawIdx.get('raw.mktOptDeltaFlow24Z')!][bar] = mktOptDeltaFlow24Z[bar];
    values[rawIdx.get('raw.mktOptGammaFlow24Z')!][bar] = mktOptGammaFlow24Z[bar];
    values[rawIdx.get('raw.mktOptPutCallVol24')!][bar] = marketOptionsAligned.putCallVol24[bar];
    values[rawIdx.get('raw.mktOptSkew24')!][bar] = marketOptionsAligned.skew24[bar];
    values[rawIdx.get('raw.ownDvolZ30')!][bar] = ownDvolZ30[bar];
    values[rawIdx.get('raw.ownOptDeltaFlow24Z')!][bar] = ownOptDeltaFlow24Z[bar];
    values[rawIdx.get('raw.ownOptGammaFlow24Z')!][bar] = ownOptGammaFlow24Z[bar];
    values[rawIdx.get('raw.ownOptPutCallVol24')!][bar] = ownOptions.putCallVol24[bar];
    values[rawIdx.get('raw.ownOptSkew24')!][bar] = ownOptions.skew24[bar];

    // Diagnostics: masks of raw.ret1 by a market-wide options reading, never
    // a signal on their own (see the Stage 2 precedent above).
    const gammaFlowNow = mktGammaFlow24Masked[bar];
    const gammaFlowKnown = Number.isFinite(gammaFlowNow) && Number.isFinite(r1);
    values[rawIdx.get('raw.ret1InHighDvol')!][bar] = dvolTercile.high[bar] === 1 && Number.isFinite(r1) ? r1 : NaN;
    values[rawIdx.get('raw.ret1InLowDvol')!][bar] = dvolTercile.low[bar] === 1 && Number.isFinite(r1) ? r1 : NaN;
    values[rawIdx.get('raw.ret1InPosGammaFlow')!][bar] = gammaFlowKnown && gammaFlowNow > 0 ? r1 : NaN;
    values[rawIdx.get('raw.ret1InNegGammaFlow')!][bar] = gammaFlowKnown && gammaFlowNow <= 0 ? r1 : NaN;
  }

  return {
    names,
    categories,
    values,
    warmupBars,
    timestamps: candles.map((c) => c.t),
    closes: candles.map((c) => c.c),
    perpCloses: candles.map((c) => perpByTime.get(c.t)?.c ?? NaN),
  };
}
