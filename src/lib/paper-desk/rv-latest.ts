/**
 * The read model of the rv-v1 paper desk: the JSON that
 * GET /api/signals/cross-sectional/latest returns, and the pure helpers the
 * route and the dashboard card share. No database, network or clock access,
 * and only type imports, so the card can use it in the browser bundle.
 */
import type {
  RvFactorRow,
  RvRanked,
  RvSkipReason,
  RvStepRecord,
} from '@/lib/signals/cross-sectional/engine';
import type { RvAlerts, RvBookState, RvFillStats, RvValidationStatus } from '@/lib/models/rv-book';
import type { RvSignalSettlementInput } from '@/lib/models/rv-signal';

/** A run of losing taker steps is flagged from this length on. */
export const NEGATIVE_STREAK_FLAG = 10;

export type RvAlertKind = 'drawdown_taker' | 'drawdown_maker' | 'negative_streak';

/** RvSignal as JSON. */
export interface RvSignalView {
  version: 'rv-v1';
  barTime: number;
  barCloseTime: number;
  rows: RvFactorRow[];
  ranked: RvRanked[];
  skipped: { symbol: string; reason: RvSkipReason }[];
  inputs: {
    lastBarOpenTime: Record<string, number | null>;
    settlement: Record<string, RvSignalSettlementInput | null>;
  };
  createdAt: string;
}

/** RvStep as JSON. A pending step has null records and at least one reason. */
export interface RvStepView {
  bookName: string;
  barTime: number;
  fillTime: number;
  targets: Record<string, number> | null;
  taker: RvStepRecord | null;
  maker: RvStepRecord | null;
  bookAfter: RvBookState | null;
  rebalanceHourUtc: number;
  isWeekend: boolean;
  pendingReasons: string[];
  createdAt: string;
}

/** RvBook as JSON, without the lease fields. */
export interface RvBookView extends RvBookState {
  bookName: string;
  version: 'rv-v1';
  validationStatus: RvValidationStatus;
  validationRef: string | null;
  startedAt: string;
  startBarTime: number | null;
  lastStepBarTime: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The newest completed step whose book state carried a raised flag. */
export interface RvLastAlert {
  barTime: number;
  fillTime: number;
  kinds: RvAlertKind[];
}

/** The archived pre-rv-v1 book, read-only. */
export interface RvLegacyBookView {
  bookName: 'rv-8h-buffer2';
  equityMaker: number;
  equityTaker: number;
  lastProcessedBarTime: number | null;
}

export interface RvLatestResponse {
  success: true;
  /** Newest stored rv-v1 signal. */
  signal: RvSignalView | null;
  /** Newest RvStep by barTime, pending or completed. */
  step: RvStepView | null;
  /** Newest completed RvStep, the source of every figure on the card. */
  completedStep: RvStepView | null;
  book: RvBookView | null;
  /** RV_V1.costs: fee rates as fractions, slippage in bps. */
  costs: { takerFee: number; makerFee: number; takerSlippageBps: number };
  /**
   * From RV_V1 and the desk: composite weights, legs per side, the starting
   * equity of each track, and the drawdown below peak that raises a flag.
   */
  rule: {
    weights: { mom: number; idio: number; carry: number; flow: number };
    legs: number;
    startingEquity: number;
    drawdownFlag: number;
  };
  lastAlert: RvLastAlert | null;
  legacy: RvLegacyBookView | null;
}

/** Which flags are raised now. Flags are descriptive, they never stop the desk. */
export function raisedAlertKinds(alerts: RvAlerts): RvAlertKind[] {
  const kinds: RvAlertKind[] = [];
  if (alerts.drawdownTaker) kinds.push('drawdown_taker');
  if (alerts.drawdownMaker) kinds.push('drawdown_maker');
  if (alerts.negativeStreak >= NEGATIVE_STREAK_FLAG) kinds.push('negative_streak');
  return kinds;
}

export interface RvMakerFillRate {
  filled: number;
  fallback: number;
  /** filled / (filled + fallback), null before the maker track has placed an order. */
  rate: number | null;
}

/**
 * Maker fills against taker fallbacks over the hour buckets. The weekday and
 * weekend buckets count the same orders again, so they are left out.
 */
export function makerFillRate(fillStats: RvFillStats): RvMakerFillRate {
  let filled = 0;
  let fallback = 0;
  for (const key of ['00', '08', '16'] as const) {
    filled += fillStats[key].makerFilled;
    fallback += fillStats[key].makerFallback;
  }
  const orders = filled + fallback;
  return { filled, fallback, rate: orders > 0 ? filled / orders : null };
}

/** The short form of a pending reason: the text before the first space, without a trailing colon. */
export function pendingReasonLabel(reason: string): string {
  const prefix = reason.split(' ')[0];
  return prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
}

/**
 * Whether a step is still waiting on data. A pending step at or behind the
 * cursor is an orphan of a first run that never completed, not a stall.
 */
export function isPendingStep(
  step: Pick<RvStepView, 'barTime' | 'bookAfter'>,
  cursor: number | null
): boolean {
  return step.bookAfter === null && (cursor === null || step.barTime > cursor);
}

export interface RvPositionRow {
  symbol: string;
  side: 'long' | 'short';
  /** Notional over equity, signed, from the taker track (the maker track when only it holds the leg). */
  weight: number;
  entry: number;
  lastPrice: number;
  unrealizedTaker: number | null;
  unrealizedMaker: number | null;
  /** The last completed step had no fill bar for this symbol, so its price is older. */
  stale: boolean;
  makerOnly: boolean;
}

/**
 * The legs the book holds after its last completed step, one row per symbol
 * across both tracks. Longs first, then the largest absolute weight first.
 */
export function positionRows(book: RvBookView, completedStep: RvStepView | null): RvPositionRow[] {
  const taker = book.tracks.taker.positions;
  const maker = book.tracks.maker.positions;
  const stale = new Set([...(completedStep?.taker?.stale ?? []), ...(completedStep?.maker?.stale ?? [])]);
  const symbols = new Set(
    [...Object.entries(taker), ...Object.entries(maker)].filter(([, p]) => p.qty !== 0).map(([s]) => s)
  );

  const rows: RvPositionRow[] = [];
  for (const symbol of symbols) {
    const t = taker[symbol] && taker[symbol].qty !== 0 ? taker[symbol] : null;
    const m = maker[symbol] && maker[symbol].qty !== 0 ? maker[symbol] : null;
    const base = t ?? m!;
    const equity = t ? book.equity.taker : book.equity.maker;
    rows.push({
      symbol,
      side: base.qty > 0 ? 'long' : 'short',
      weight: (base.qty * base.lastMark) / equity,
      entry: base.avgEntry,
      lastPrice: base.lastMark,
      unrealizedTaker: t ? t.qty * (t.lastMark - t.avgEntry) : null,
      unrealizedMaker: m ? m.qty * (m.lastMark - m.avgEntry) : null,
      stale: stale.has(symbol),
      makerOnly: t === null,
    });
  }
  const sideOrder = { long: 0, short: 1 };
  return rows.sort(
    (a, b) =>
      sideOrder[a.side] - sideOrder[b.side] ||
      Math.abs(b.weight) - Math.abs(a.weight) ||
      a.symbol.localeCompare(b.symbol)
  );
}
