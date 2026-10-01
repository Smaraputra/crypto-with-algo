/**
 * Banded target-exposure simulator: a pure research path, deliberately NOT an
 * engine change.
 *
 * WHY THIS IS A SEPARATE PATH
 *
 * The discrete-entry engine cannot express a target exposure, and bending it
 * to try would be the wrong move. `runBarLoop` holds exactly one position in
 * two nullable slots (`position` and `pending`), `EntryDecision` carries no
 * quantity, weight or exposure field, `decideExit` returns a bare boolean, and
 * decisively equity there is realized-only: it moves solely through
 * `computeEquityAfterTrade`, called at close sites, so the per-bar equity curve
 * is flat for the whole duration of an open position. There is no
 * mark-to-market anywhere in the engine, and a banded exposure is nothing but
 * a mark-to-market path.
 *
 * All eight validation gates are downstream of `BacktestResult.trades`, not
 * four of them, so the exposure path also cannot reuse `poolStrategyResults`.
 * It carries its own gate module and its own report schema.
 *
 * WHAT IT MEASURES
 *
 * The hypothesis Phase 4b left open: an autocorrelated factor is not a supply
 * of independent bets, so `IR = IC * sqrt(breadth)` with a breadth of roughly
 * one (one position, one symbol, stop and target frozen at fill) is the wrong
 * container. Holding the same factor as a banded target exposure across all
 * ten symbols at once attacks both costs that killed the discrete version:
 * turnover, because the band suppresses rebalancing while the position barely
 * needs to move, and lost breadth, because ten symbols are held continuously
 * instead of one at a time.
 *
 * THE MODEL, STATED EXACTLY
 *
 * - Weights are FIXED through the bar, not drifted. At the close of bar t a
 *   symbol's weight is still `w[t]`; the whole return for t -> t+1 is earned at
 *   that weight. Drifting the weight with the return is more faithful to a
 *   real book but makes the band's state path-dependent and the arithmetic
 *   hard to check by hand. Fixed-within-bar is the standard discrete
 *   rebalancing convention and it is what the tests below pin.
 *
 * - The signal at bar t is observable at bar t's OPEN and the return it earns
 *   is t -> t+1. That is an execution lag of one bar, which is the discipline
 *   the factor study settled on 2026-09-20 after finding that roughly half of
 *   Phase 3's intraday reversal was the bid-ask bounce. `ResearchRow` already
 *   satisfies this: the value at index i was observable at or before
 *   `candles[i].timestamp`, the bar's open.
 *
 * - Costs are charged on TURNOVER, not on trades: `|dw| * (takerFee +
 *   slippageBps/10000)` at each rebalance, from `studyCostConfig`, so the
 *   exposure path and the discrete path are priced from one source.
 *
 * - Funding accrues on the held weight at the 8h boundaries the bar spans, via
 *   `fundingCrossings` and `fundingPnl`, the same two functions the engines
 *   use. A traded-weight notional of `|w|` in a portfolio whose total gross is
 *   `gross` carries funding in proportion to `|w| / gross`.
 *
 *   Charged exactly as `accrueFunding` in `trade-utils.ts` charges it:
 *   `fundingPnl(notional, rate, side, crossings)` with the bar's whole
 *   crossing count. The rate column is the snapshot's last SETTLED rate,
 *   carried forward onto every bar, not one settlement per bar, so a 1d bar
 *   that spans three 8h boundaries owes three settlements. Using the one rate
 *   for all three is a stale-rate approximation (exact on a flat rate), the
 *   same one the engines make. Until 2026-10-01 this charged a single
 *   settlement per bar on the reasoning that the per-bar rate "is the rate
 *   settling at that boundary", which undercharged every 1d bar by two
 *   thirds; 1h and 4h bars cross at most one boundary and were unaffected
 *   (review finding M8). The Phase 5 1d rows in `exposure-gates.ts` were
 *   computed before the fix.
 *
 *   `FUNDING_INTERVAL_MS` in `funding.ts` is a fixed 8h, so a symbol whose
 *   settlement interval Binance shortened to 4h is undercounted here and in
 *   both engines.
 *
 * - The bootstrap block length is set from the holding horizon, NOT by the
 *   `max(2, round(cbrt(n)))` rule `strategy-gates.ts` uses. See
 *   `bootstrapBlockLength` below: the discrete rule is calibrated on a trade
 *   count and would be badly undersized on autocorrelated bar returns, which
 *   is exactly how a false pass gets manufactured.
 *
 * - Gross is normalised to a cap so the portfolio is one object with one
 *   return series rather than ten independent runs pooled at the end, which is
 *   what collapsed breadth in Phase 4. The cap is a divisor, so a grid cell
 *   that leaves the book under-invested is not rescued by scaling it up: the
 *   number reported is the return actually earned per unit of gross deployed.
 *
 * - `topBottom` / `linearRank` band the REBALANCE DECISION, not each symbol's
 *   own weight, and that is a deliberate departure from the tanh path's
 *   per-symbol band. A joint target is dollar-neutral by construction (the
 *   weights sum to zero across the WHOLE cross-section), and a per-symbol
 *   band would let one symbol move to its new target while its neighbours sit
 *   still, which breaks the sum-to-zero invariant on every bar in between --
 *   exactly the invariant a dollar-neutral book is built to hold. So the band
 *   gates one decision per bar (rebalance every symbol to its fresh target, or
 *   leave every symbol exactly where it was), never a subset. A symbol whose
 *   signal drops to NaN while it still holds a non-zero weight forces that
 *   rebalance regardless of the band, because leaving a stale leg in a
 *   book whose other legs keep moving is the one path that guarantees a
 *   nonzero net exposure. See `simulateExposure`'s bar loop for the exact
 *   rule.
 *
 * Pure: no fetch, no Mongo, no filesystem, no clock. Every input arrives as an
 * argument, so the whole model is unit-testable and a spot check of a saved
 * report re-runs the identical arithmetic.
 */

import { fundingCrossings, fundingPnl } from '@/lib/backtest/funding';
import { studyCostConfig, type FeeProfileName } from '@/lib/backtest/cost-model';

/** One symbol's bars, already joined to its research column. Arrays are
 * parallel and the same length; NaN in `z` means no reading at that bar. */
export interface ExposureSymbolInput {
  symbol: string;
  /** Bar open times, ascending. The signal at t earns the return t -> t+1. */
  timestamps: number[];
  /** Perp closes, aligned to `timestamps`. */
  closes: number[];
  /** 8h funding rate readings at or before each bar's OPEN, NaN when absent. */
  fundingRates: number[];
  /** The factor column, read at the bar's open. NaN means do not trade. */
  z: number[];
}

/**
 * How a bar's target is formed.
 *
 * `tanh`: per symbol, independent of every other symbol, from `targetExposure`.
 * The default, and the path every existing report was measured on.
 *
 * `topBottom` / `linearRank`: JOINTLY across the cross-section, from
 * `crossSectionalTargets`. Long the k lowest (or the whole ranked book for
 * `linearRank`) readings and short the k highest under `factorSign`,
 * dollar-neutral and unit-gross by construction, so `grid.gross` is not
 * applied to these two.
 */
export type TargetScheme = 'tanh' | 'topBottom' | 'linearRank';

export interface ExposureGrid {
  /**
   * `tanh`: rebalance only THIS symbol when |target - held| exceeds this. 0
   * rebalances every bar.
   *
   * `topBottom` / `linearRank`: a BOOK-LEVEL gate, not a per-symbol one --
   * rebalance EVERY symbol to its fresh target when the largest single-symbol
   * move (max over symbols of |target - held|) exceeds this, or hold EVERY
   * symbol exactly where it was. A per-symbol gate cannot be used here: it
   * would let a subset of symbols move to their new targets while the rest
   * sit still, which breaks the sum-to-zero weighting a joint target promises
   * on every bar in between. See `simulateExposure` for the exact rule,
   * including the forced rebalance a NaN dropout with a stale nonzero leg
   * triggers regardless of this value.
   */
  band: number;
  /** target = -tanh(z / zScale), in (-1, +1). The sign is contrarian. Read
   * only when `scheme` is 'tanh' (the default). */
  zScale: number;
  /** Trailing bars averaged into the signal. 0 is no smoothing. */
  smoothing: number;
  /** Divisor normalising the summed raw targets to a unit gross book. Not
   * applied to `topBottom` / `linearRank`, which are unit-gross already. */
  gross: number;
  /** Trading interval, used only to look up the study slippage budget. */
  interval: string;
  /** How the bar's target is formed. Default 'tanh', byte-identical to
   * before this field existed. */
  scheme?: TargetScheme;
  /** Symbols per leg for `topBottom` (k). Default 1. Unused by 'tanh' and
   * 'linearRank'. */
  legs?: number;
  /** Sign under which a HIGH reading is long. Default 1. Multiplies the
   * signal before ranking; every rank-scheme reasoning in this module is
   * stated for `factorSign: -1` (a high reading is crowded, so short it). */
  factorSign?: 1 | -1;
  /** Minimum finite readings required to form a rank target; below it every
   * symbol holds (unchanged). Default 5. Unused by 'tanh'. */
  minCrossSection?: number;
}

export interface ExposureOptions {
  /** Overrides the study taker fee, for the stress gate. */
  feeMultiplier?: number;
  /** Overrides the study slippage, for the stress gate. */
  slippageMultiplier?: number;
  /** Fee schedule each symbol prices under, resolved per symbol (a
   * symbol-scoped profile falls back for a symbol it does not cover).
   * Default: DEFAULT_FEE_PROFILE ('standard'), byte-identical to before this
   * option existed. */
  feeProfile?: FeeProfileName;
  /** 'maker' prices turnover at the resolved profile's makerFeePercent with
   * zero slippage (still scaled by feeMultiplier); default 'taker' is
   * byte-identical to before this option existed. */
  fill?: 'taker' | 'maker';
}

export interface ExposureSymbolResult {
  symbol: string;
  /** Per-bar portfolio return contribution, before costs. */
  returnContribution: number[];
  /** Per-bar signed target the signal asked for. */
  target: number[];
  /** Per-bar weight actually exposed over the following bar's return. */
  held: number[];
  /** Total |dw| traded for this symbol over the run. */
  turnover: number;
  /** Tradeable bars: finite z and a finite return. */
  bars: number;
  /** Mean contribution per bar, a per-symbol expectancy proxy. */
  meanContribution: number;
}

export interface ExposureResult {
  /** Net portfolio return per bar, after turnover and funding. */
  netReturns: number[];
  /** Total gross turnover per bar, as a fraction of the ticked gross. */
  turnover: number[];
  /** Signed gross exposure per bar (sum of |held|). */
  grossExposure: number[];
  /** Trading cost per bar, always <= 0. */
  costReturns: number[];
  /** Funding charge per bar, always <= 0 (its sign already carries the side). */
  fundingReturns: number[];
  /** Net (signed) exposure per bar: sum of held weights, not their
   * magnitude. Zero (within float tolerance) on every traded bar of a
   * dollar-neutral rank scheme. */
  netExposure: number[];
  /** Per-bar return contribution summed over symbols held long (held > 0). */
  longLegReturns: number[];
  /** Per-bar return contribution summed over symbols held short (held < 0). */
  shortLegReturns: number[];
  perSymbol: ExposureSymbolResult[];
  /** Bars in the common grid. */
  bars: number;
  /** Bars skipped because an input was missing on at least one symbol. */
  incompleteBars: number;
  /** Mean number of bars between rebalances across symbols. This is what the
   * bootstrap block length is derived from, NOT `cbrt(n)`. */
  meanBarsBetweenRebalances: number;
}

const EPSILON = 1e-12;

/**
 * Contrarian target for one reading: positive z means crowded long, so the
 * exposure is short. NaN in gives NaN out, which every caller treats as "do
 * not trade".
 *
 * SATURATING, NOT CLAMPING, and that distinction is the whole reason this path
 * was rebuilt once. A hard `clamp(-z / zScale)` on a trailing z is effectively
 * BINARY: |z| exceeds 1 on most bars, so almost every reading saturates to
 * +1 or -1 regardless of how crowded the book actually is. With a binary
 * target the band is not a hedge, it is a lag: the target only ever moves by
 * 2.0, so a band can only ever suppress a reposition the signal genuinely
 * asked for, never reduce churn. The first grid run selected `band = 0` in 11
 * of 12 windows, which is precisely what a degenerate band knob looks like.
 *
 * `tanh` keeps monotonicity and the contrarian sign while staying continuous,
 * so a larger band suppresses small target moves and leaves large ones alone.
 * That is the behaviour the phase's hypothesis is actually about: the band
 * should cut turnover while tracking the signal, not freeze it.
 *
 * The scale is still the knob that sets where saturation bites, so the grid's
 * existing zScale values keep their meaning: 1 saturates quickly, 3 is close
 * to linear over the columns' working range.
 */
export function targetExposure(z: number, zScale: number): number {
  if (!Number.isFinite(z) || !Number.isFinite(zScale) || zScale <= 0) return Number.NaN;
  return -Math.tanh(z / zScale);
}

/**
 * Joint cross-sectional target for `topBottom` / `linearRank`: unlike
 * `targetExposure`, every symbol's weight depends on where its reading falls
 * relative to the OTHERS at the same bar, not just its own magnitude.
 *
 * `factorSign` is applied first (multiplying every finite reading), so
 * everything below is stated in terms of the SIGNED value: a higher signed
 * value ranks toward the long leg. Symbols with a non-finite reading are
 * excluded from the ranking and their own output is NaN. This function does
 * NOT decide what a NaN output means to a book -- that is `simulateExposure`'s
 * job, and it does not read the NaN as "hold": a symbol dropping out of the
 * cross-section targets 0 (flat), which is what keeps the book dollar-neutral
 * when a leg's reading disappears.
 *
 * Below `minCrossSection` finite readings, the whole output is NaN (every
 * symbol, not just the non-finite ones) rather than ranking a too-thin
 * cross-section; `simulateExposure` reads THAT case as "hold, do not trade
 * anyone this bar".
 *
 * Ties (equal signed value) are broken by ascending original index, so the
 * assignment is deterministic and stable under any array reordering that
 * preserves index identity.
 *
 * `topBottom`: the `legs` (k) symbols at the HEAD of the descending-signed
 * sort (the highest signed values) each get `+1 / (2k)`; the `legs` at the
 * TAIL (the lowest signed values) each get `-1 / (2k)`. Every other symbol is
 * 0. Throws if `2 * legs` exceeds the finite count, since the two legs would
 * otherwise overlap.
 *
 * `linearRank`: every finite symbol gets a rank from 1 (lowest signed value)
 * to n (highest), weight `(rank - (n+1)/2) / sum_{r=1..n} |r - (n+1)/2|`, so
 * the weights sum to (near) zero and the largest magnitude is at the two
 * extremes.
 *
 * Both schemes are unit-gross by construction (sum of |weight| = 1), which is
 * asserted below as a debug check: it should be true by the arithmetic alone,
 * and a violation means the arithmetic above has a bug.
 */
export function crossSectionalTargets(
  signals: readonly number[],
  grid: Pick<ExposureGrid, 'scheme' | 'legs' | 'factorSign' | 'minCrossSection'>
): number[] {
  const n = signals.length;
  const factorSign = grid.factorSign ?? 1;
  const minCrossSection = grid.minCrossSection ?? 5;
  const scheme = grid.scheme;

  const out = new Array<number>(n).fill(Number.NaN);

  const signed = signals.map((z) => (Number.isFinite(z) ? z * factorSign : Number.NaN));
  const finiteIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(signed[i])) finiteIndices.push(i);
  }
  if (finiteIndices.length < minCrossSection) return out;

  // Descending by signed value (highest signed value = most long), ties
  // broken by ascending original index. Explicit index tie-break rather than
  // relying on sort stability, so the order is deterministic regardless of
  // engine.
  const sorted = [...finiteIndices].sort((a, b) => signed[b] - signed[a] || a - b);
  const m = sorted.length;

  if (scheme === 'topBottom') {
    const legs = grid.legs ?? 1;
    if (2 * legs > m) {
      throw new Error(
        `crossSectionalTargets: legs=${legs} needs ${2 * legs} finite readings, only ${m} available`
      );
    }
    const w = 1 / (2 * legs);
    for (const i of sorted) out[i] = 0;
    for (let i = 0; i < legs; i++) out[sorted[i]] = w;
    for (let i = 0; i < legs; i++) out[sorted[m - 1 - i]] = -w;
  } else if (scheme === 'linearRank') {
    const centre = (m + 1) / 2;
    // sorted[0] is the highest signed value, which is rank m (most long).
    const centred = sorted.map((_, i) => m - i - centre);
    const denom = centred.reduce((acc, c) => acc + Math.abs(c), 0);
    for (let i = 0; i < m; i++) {
      out[sorted[i]] = denom > 0 ? centred[i] / denom : 0;
    }
  } else {
    throw new Error(`crossSectionalTargets: unsupported scheme ${String(scheme)}`);
  }

  const sum = out.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  if (Math.abs(sum) > EPSILON) {
    throw new Error(`crossSectionalTargets: weights not dollar neutral, sum=${sum}`);
  }

  return out;
}

/**
 * The largest single-symbol weight a scheme can produce over a universe of
 * `universeSize` symbols: `1 / (2 * legs)` for `topBottom` (independent of
 * universe size, since only the two legs' k symbols ever carry weight), and
 * the centred top rank over the rank sum for `linearRank`.
 *
 * Used to express a `band` as a fraction of the scheme's own scale, since
 * `topBottom` k=1 and `linearRank` on ten symbols do not share a native unit.
 */
export function maxRankWeight(scheme: TargetScheme, legs: number | undefined, universeSize: number): number {
  if (scheme === 'topBottom') {
    const k = legs ?? 1;
    return 1 / (2 * k);
  }
  if (scheme === 'linearRank') {
    const n = universeSize;
    const centre = (n + 1) / 2;
    let denom = 0;
    for (let r = 1; r <= n; r++) denom += Math.abs(r - centre);
    const numerator = n - centre;
    return denom > 0 ? numerator / denom : 0;
  }
  throw new Error(`maxRankWeight: unsupported scheme ${String(scheme)}`);
}

/**
 * Trailing mean over `window` bars, NaN until the window is full.
 *
 * Deliberately a plain moving average and not an EMA: a fixed warmup makes the
 * bar at which a cell becomes tradeable a property of the grid, so two cells
 * can be compared on the same bars. An EMA's warmup is a judgement call and
 * would quietly change the sample the gates score.
 */
export function trailingMean(series: readonly number[], window: number): number[] {
  const out = new Array<number>(series.length).fill(Number.NaN);
  if (window <= 1) {
    for (let i = 0; i < series.length; i++) out[i] = series[i];
    return out;
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < series.length; i++) {
    const entering = series[i];
    if (Number.isFinite(entering)) {
      sum += entering;
      count++;
    }
    const leavingIndex = i - window;
    if (leavingIndex >= 0) {
      const leaving = series[leavingIndex];
      if (Number.isFinite(leaving)) {
        sum -= leaving;
        count--;
      }
    }
    out[i] = count === window ? sum / window : Number.NaN;
  }
  return out;
}

/** Close-to-close return of bar t, earned over t -> t+1. NaN when either close
 * is missing or non-positive, which then makes the whole bar incomplete rather
 * than being read as a zero return. */
function barReturn(closes: readonly number[], bar: number): number {
  if (bar + 1 >= closes.length) return Number.NaN;
  const from = closes[bar];
  const to = closes[bar + 1];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return Number.NaN;
  return to / from - 1;
}

/** Bars where the closes are not all on one grid: a per-symbol return is only
 * usable if the next bar actually is the next bar. */
function gridGaps(timestamps: readonly number[], bar: number): boolean {
  if (bar + 1 >= timestamps.length) return true;
  const step = timestamps[bar + 1] - timestamps[bar];
  return !(step > 0);
}

/**
 * Runs one grid cell over one universe and returns the per-bar net return
 * series plus the diagnostics the gates read.
 *
 * `symbols` must all share one bar grid, which the caller guarantees by
 * joining every symbol to the same candle series before calling. Bars where
 * any symbol's return is missing are dropped from the return series rather
 * than filled, and counted in `incompleteBars` so a thin universe shows up in
 * the report instead of silently shrinking the sample.
 */
export function simulateExposure(
  symbols: readonly ExposureSymbolInput[],
  grid: ExposureGrid,
  options: ExposureOptions = {}
): ExposureResult {
  if (symbols.length === 0) {
    return {
      netReturns: [],
      turnover: [],
      grossExposure: [],
      costReturns: [],
      fundingReturns: [],
      netExposure: [],
      longLegReturns: [],
      shortLegReturns: [],
      perSymbol: [],
      bars: 0,
      incompleteBars: 0,
      meanBarsBetweenRebalances: Number.NaN,
    };
  }

  // Resolved PER SYMBOL: a symbol-scoped fee profile (e.g.
  // promo-btc-eth-2026-07) prices BTCUSDT/ETHUSDT differently from every
  // other symbol in the universe. studyCostConfig returns a Pick over
  // optional BacktestConfig fields, so both are typed possibly-undefined
  // even though it always sets them. The fee falls back to 0 and the
  // slippage budget to 0 bps rather than to each other: they are separate
  // costs and conflating them would silently change the stress multipliers'
  // meaning.
  const fill = options.fill ?? 'taker';
  const costPerUnitTurnover = symbols.map((s) => {
    const c = studyCostConfig(grid.interval, { profile: options.feeProfile, symbol: s.symbol });
    // Maker: the resolved profile's maker rate, still scaled by feeMultiplier,
    // and zero slippage -- a resting order does not cross the book. Taker
    // (default): unchanged from before this option existed.
    const fee =
      fill === 'maker'
        ? (c.makerFeePercent ?? 0) * (options.feeMultiplier ?? 1)
        : (c.takerFeePercent ?? 0) * (options.feeMultiplier ?? 1);
    const slippage =
      fill === 'maker' ? 0 : ((c.slippageBps ?? 0) / 10000) * (options.slippageMultiplier ?? 1);
    return fee + slippage;
  });

  const gross = grid.gross > 0 ? grid.gross : 1;

  const length = symbols[0].timestamps.length;
  for (const s of symbols) {
    if (s.timestamps.length !== length) {
      throw new Error(
        `simulateExposure: ${s.symbol} has ${s.timestamps.length} bars, expected ${length}. ` +
          'Every symbol must be joined to the same bar grid.'
      );
    }
  }

  // Signal per symbol, then the targets that signal asks for.
  const signal: number[][] = symbols.map((s) =>
    grid.smoothing > 1 ? trailingMean(s.z, grid.smoothing) : [...s.z]
  );

  const held: number[][] = symbols.map(() => new Array<number>(length).fill(0));
  const rebalanceCounts: number[] = symbols.map(() => 0);
  const turnoverTotals: number[] = symbols.map(() => 0);

  const netReturns: number[] = [];
  const turnoverSeries: number[] = [];
  const grossSeries: number[] = [];
  const costSeries: number[] = [];
  const fundingSeries: number[] = [];
  const netExposureSeries: number[] = [];
  const longLegSeries: number[] = [];
  const shortLegSeries: number[] = [];
  const perSymbolReturns: number[][] = symbols.map(() => []);

  let incompleteBars = 0;
  let skippedBars = 0;

  // Both are [symbol][bar], not [bar] alone: every symbol has its own return
  // and its own target on each bar. A flat per-bar array would hand every
  // symbol symbol 0's return, which is silent and reports plausible numbers.
  // Declared outside the bar loop so index t keeps meaning bar t.
  const returns: number[][] = symbols.map(() => []);
  const targets: number[][] = symbols.map(() => []);

  // 'topBottom' / 'linearRank' form the target JOINTLY across symbols and
  // rebalance at the BOOK level (see `ExposureGrid.band`), rather than per
  // symbol like the tanh path. The tanh branch (scheme undefined or 'tanh')
  // is untouched below so its numbers stay byte-identical to before this
  // scheme existed.
  const isRankScheme = grid.scheme === 'topBottom' || grid.scheme === 'linearRank';
  const minCrossSection = grid.minCrossSection ?? 5;

  // Bar t earns the return t -> t+1, so the last bar has no return to earn and
  // is never traded into.
  for (let t = 0; t < length - 1; t++) {
    let complete = true;

    for (let s = 0; s < symbols.length; s++) {
      const r = barReturn(symbols[s].closes, t);
      if (!Number.isFinite(r) || gridGaps(symbols[s].timestamps, t)) {
        complete = false;
        break;
      }
      returns[s].push(r);
      if (!isRankScheme) {
        // tanh: unchanged from before the rank schemes existed. Computed
        // here, inside the completeness loop, exactly as it always was.
        const raw = targetExposure(signal[s][t], grid.zScale);
        targets[s].push(Number.isFinite(raw) ? raw / gross : Number.NaN);
      }
    }

    if (!complete) {
      incompleteBars++;
      skippedBars++;
      // Drop the partial row so each column stays exactly one entry per bar
      // and index t keeps meaning bar t.
      for (let s = 0; s < symbols.length; s++) {
        returns[s].length = t;
        if (!isRankScheme) targets[s].length = t;
      }
      for (let s = 0; s < symbols.length; s++) {
        // Carry the held weight forward across an unusable bar so a gap does
        // not silently look like a flat position.
        held[s][t + 1] = held[s][t];
        // NaN, not 0: this bar contributes nothing because its return is
        // missing, and a 0 here would read as a real flat bar when the
        // per-symbol mean is taken.
        perSymbolReturns[s].push(Number.NaN);
      }
      netReturns.push(0);
      turnoverSeries.push(0);
      grossSeries.push(0);
      costSeries.push(0);
      fundingSeries.push(0);
      netExposureSeries.push(0);
      longLegSeries.push(0);
      shortLegSeries.push(0);
      continue;
    }

    // The bar is known complete. Only NOW is it worth forming the rank
    // targets: a bar later discarded above never reaches `crossSectionalTargets`,
    // so its `2 * legs` guard can never throw over a bar that is not even
    // used.
    let bookTargets: number[] | null = null;
    let bookRebalance = false;
    if (isRankScheme) {
      const signalsAtT = symbols.map((_, s) => signal[s][t]);
      const finiteCount = signalsAtT.filter((z) => Number.isFinite(z)).length;
      if (finiteCount >= minCrossSection) {
        const ranked = crossSectionalTargets(signalsAtT, grid);
        // A symbol whose signal is NaN is not in the cross-section: its
        // target is 0 (flat), never "hold whatever it had", or a stale leg
        // would sit in the book while the ranked symbols keep moving and the
        // sum-to-zero invariant would break.
        bookTargets = ranked.map((v) => (Number.isFinite(v) ? v : 0));
        let maxAbsDelta = 0;
        let forceRebalance = false;
        for (let s = 0; s < symbols.length; s++) {
          const delta = Math.abs(bookTargets[s] - held[s][t]);
          if (delta > maxAbsDelta) maxAbsDelta = delta;
          // A dropout still holding a non-zero weight forces the rebalance
          // regardless of the band: leaving that stale leg in place while the
          // rest of the book may or may not move is the one path that
          // guarantees a non-zero net exposure.
          if (!Number.isFinite(signalsAtT[s]) && held[s][t] !== 0) forceRebalance = true;
        }
        // + EPSILON matches the tanh branch's tie convention below. Inert on
        // the shipped grid: linearRank moves are multiples of 1/25 = 0.04
        // against bands of 0.045 and 0.09, topBottom moves are 0.25/0.5
        // against 0.125/0.25, so exact equality with `grid.band` never arises.
        bookRebalance = maxAbsDelta > grid.band + EPSILON || forceRebalance;
      }
      // Below minCrossSection: bookTargets stays null and bookRebalance stays
      // false, so every symbol holds below, exactly as the tanh path holds
      // on a NaN target.
    }

    let costThisBar = 0;
    let fundingThisBar = 0;
    let grossThisBar = 0;
    let returnThisBar = 0;
    let turnoverThisBar = 0;
    let netExposureThisBar = 0;
    let longLegThisBar = 0;
    let shortLegThisBar = 0;

    for (let s = 0; s < symbols.length; s++) {
      const previous = held[s][t];

      let trade: boolean;
      let exposure: number;
      if (isRankScheme) {
        // Book-level: either every symbol moves to its fresh target, or none
        // do. Never a per-symbol decision -- see `ExposureGrid.band`.
        if (bookTargets && bookRebalance) {
          exposure = bookTargets[s];
          trade = Math.abs(exposure - previous) > EPSILON;
        } else {
          exposure = previous;
          trade = false;
        }
      } else {
        const target = targets[s][t];
        // A NaN target means "no reading this bar": hold, and do not trade.
        trade = Number.isFinite(target) && Math.abs(target - previous) > grid.band + EPSILON;
        // The trade happens at this bar's OPEN, so the weight carried through
        // t -> t+1 is the post-trade one. That is also what makes the
        // execution lag real: the signal read at t is acted on at t and earns
        // t's return, rather than sitting out a bar.
        exposure = trade ? target : previous;
      }

      if (trade) {
        const delta = Math.abs(exposure - previous);
        rebalanceCounts[s]++;
        turnoverTotals[s] += delta;
        // Accumulated directly, not derived by dividing cost back out: with
        // per-symbol costs there is no single divisor that recovers unit
        // turnover from a summed cost.
        turnoverThisBar += delta;
        costThisBar += delta * costPerUnitTurnover[s];
      }
      held[s][t + 1] = exposure;

      const contribution = exposure * returns[s][t];
      returnThisBar += contribution;
      grossThisBar += Math.abs(exposure);
      perSymbolReturns[s].push(contribution);
      netExposureThisBar += exposure;
      if (exposure > 0) longLegThisBar += contribution;
      else if (exposure < 0) shortLegThisBar += contribution;

      const rate = symbols[s].fundingRates[t];
      if (Number.isFinite(rate) && exposure !== 0) {
        const crossings = fundingCrossings(symbols[s].timestamps[t], symbols[s].timestamps[t + 1]);
        if (crossings > 0) {
          // Every settlement the bar spans is owed, at the last settled rate
          // (see the header): a 1d bar pays three, a 1h or 4h bar at most one.
          const side = exposure > 0 ? 'long' : 'short';
          fundingThisBar += Math.abs(exposure) * fundingPnl(1, rate, side, crossings);
        }
      }
    }

    const net = returnThisBar - costThisBar + fundingThisBar;
    netReturns.push(net);
    turnoverSeries.push(turnoverThisBar);
    grossSeries.push(grossThisBar);
    costSeries.push(-costThisBar);
    fundingSeries.push(fundingThisBar);
    netExposureSeries.push(netExposureThisBar);
    longLegSeries.push(longLegThisBar);
    shortLegSeries.push(shortLegThisBar);
  }

  const meanBarsBetweenRebalances = meanBarsBetweenRebalancesOf(rebalanceCounts, turnoverSeries.length);

  return {
    netReturns,
    turnover: turnoverSeries,
    grossExposure: grossSeries,
    costReturns: costSeries,
    fundingReturns: fundingSeries,
    netExposure: netExposureSeries,
    longLegReturns: longLegSeries,
    shortLegReturns: shortLegSeries,
    perSymbol: symbols.map((s, index) => {
      const contributions = perSymbolReturns[index];
      const finite = contributions.filter((v) => Number.isFinite(v));
      return {
        symbol: s.symbol,
        returnContribution: contributions,
        target: signal[index],
        held: held[index],
        turnover: turnoverTotals[index],
        bars: finite.length,
        meanContribution: finite.length > 0 ? mean(finite) : Number.NaN,
      };
    }),
    bars: netReturns.length - skippedBars,
    incompleteBars,
    meanBarsBetweenRebalances,
  };
}

/**
 * Mean distance in bars between rebalances, averaged over the symbols that
 * rebalanced at all.
 *
 * NOT `bars / totalRebalances`: at 1d with ten symbols a calm cell rebalances
 * rarely per symbol, and that ratio would understate the spacing by roughly the
 * symbol count, which is exactly the direction that makes the bootstrap block
 * too short and the confidence interval too tight. Each symbol's own spacing is
 * computed first, then averaged, and symbols that never rebalanced are excluded
 * rather than dragging the mean toward infinity.
 *
 * Returns Infinity when nothing in the universe ever rebalanced, which the
 * caller must reject rather than use as a block length.
 */
function meanBarsBetweenRebalancesOf(rebalanceCounts: readonly number[], bars: number): number {
  if (bars <= 0) return Number.NaN;
  const spacings = rebalanceCounts.filter((c) => c > 0).map((c) => bars / c);
  if (spacings.length === 0) return Number.POSITIVE_INFINITY;
  return mean(spacings);
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return values.length > 0 ? sum / values.length : Number.NaN;
}

/**
 * The factor's measured decay horizon, in bars: the longest forward horizon
 * the Phase 3b factor study measured, and the one the positioning IC peaks at
 * (`1d h32 ic -0.218`, the largest effect the program has recorded).
 */
export const FACTOR_DECAY_HORIZON_BARS = 32;

/**
 * Bootstrap block length for a run.
 *
 * THIS IS NOT `max(2, round(cbrt(n)))`, and the reason is the whole point of
 * the exposure path's gate module. That rule lives in `strategy-gates.ts` and
 * is calibrated on a TRADE count: a discrete run's observations are round
 * trips, which are far fewer and far less autocorrelated than bars. A banded
 * exposure produces one observation per bar AND its weight barely changes
 * between rebalances by construction, so its return series is autocorrelated
 * to a degree the trade-count rule never anticipated. `cbrt(n)` on a bar count
 * of a hundred thousand lands near 46, which sounds large but is a fixed
 * fraction of the sample that shrinks relative to nothing; the block has to be
 * measured against the horizon over which the position persists.
 *
 * So the block is set from the container's own holding horizon: at least the
 * mean bars between rebalances the run actually realised, and never below the
 * factor's decay horizon. Both terms are reported on the report, so a reviewer
 * can see the realised length rather than trusting the rule.
 */
export function bootstrapBlockLength(meanBarsBetweenRebalances: number): number {
  const floor = FACTOR_DECAY_HORIZON_BARS;
  if (!Number.isFinite(meanBarsBetweenRebalances) || meanBarsBetweenRebalances <= 0) return floor;
  return Math.max(floor, Math.round(meanBarsBetweenRebalances));
}

/**
 * Circular block shuffle of one signal column, preserving its autocorrelation.
 *
 * This is the exposure path's null for the timing gate, and the reason it is a
 * BLOCK shuffle and not a plain one is the whole point: the factor is highly
 * autocorrelated by construction, so a plain shuffle would destroy that and
 * produce a null that is trivially beaten. A null that removes the property
 * under test is a strawman and would manufacture a pass.
 *
 * The blocks are cut from one circular permutation of the series, so every
 * element is used exactly once and no value is duplicated.
 */
export function circularBlockShuffle(
  values: readonly number[],
  blockLength: number,
  random: () => number
): number[] {
  const n = values.length;
  if (n === 0) return [];
  const block = Math.max(1, Math.floor(blockLength));
  const blocks: number[][] = [];
  for (let start = 0; start < n; start += block) {
    const chunk: number[] = [];
    for (let i = start; i < Math.min(start + block, n); i++) chunk.push(values[i]);
    blocks.push(chunk);
  }
  // Fisher-Yates over the block order, then read out circularly.
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = blocks[i];
    blocks[i] = blocks[j];
    blocks[j] = tmp;
  }
  const out: number[] = [];
  for (const chunk of blocks) {
    for (const v of chunk) out.push(v);
  }
  return out.slice(0, n);
}
