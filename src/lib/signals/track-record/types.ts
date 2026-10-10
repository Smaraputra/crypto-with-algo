import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalTier } from '@/types/signal';

/**
 * The historical re-score this build displays. Pinned in code, not "the newest
 * run in the database", so a test load can never silently replace what the
 * chart shows. A new re-score is a new id here and a reviewed change.
 */
export const TRACK_RECORD_RUN_ID = 'v8-rescore-2026-10-10';

/** The six cells the re-score covers: the scheduler's style for each scored interval. */
export const TRACK_RECORD_CELLS: ReadonlyArray<{ style: TradingStyle; interval: string; horizonBars: number }> = [
  { style: 'scalping', interval: '5m', horizonBars: 12 },
  { style: 'day_trading', interval: '15m', horizonBars: 24 },
  { style: 'day_trading', interval: '1h', horizonBars: 24 },
  { style: 'swing_trading', interval: '4h', horizonBars: 30 },
  { style: 'swing_trading', interval: '1d', horizonBars: 30 },
  { style: 'position_trading', interval: '1d', horizonBars: 20 },
];

export function trackRecordCell(style: TradingStyle | null, interval: string) {
  return TRACK_RECORD_CELLS.find((c) => c.style === style && c.interval === interval) ?? null;
}

/**
 * How a directional call ended, judged on the live resolver's outcome (the
 * close-to-close return over the style's horizon) with d = +1 for buy tiers and
 * -1 for sell tiers:
 * - `won`: d x return > round-trip cost, it made money after costs;
 * - `cost`: 0 < d x return <= cost, the direction was right but costs ate the move;
 * - `wrong`: d x return <= 0, the price went the other way (or nowhere).
 */
export type CallOutcome = 'won' | 'cost' | 'wrong';

export type TrackSource = 'rescore' | 'live';

/** One scored bar on the chart. Neutral bars are included: the score pane draws every bar. */
export interface TrackBar {
  /** Candle open time, epoch ms UTC. */
  t: number;
  score: number;
  tier: SignalTier;
  /** Close-to-close forward return in percent; null while a live outcome is pending or unresolvable. */
  fwd: number | null;
  source: TrackSource;
}

/**
 * Point measures over a set of calls. Every rate is a share in [0, 1] and every
 * return is in percent. A measure with no rows to stand on is null, never NaN,
 * so it survives JSON.
 */
export interface PointMeasures {
  /** Buy-tier plus sell-tier rows. */
  calls: number;
  buyN: number;
  sellN: number;
  /** Share of buy calls followed by a rise. */
  buyHit: number | null;
  /** Share of sell calls followed by a fall. */
  sellHit: number | null;
  /** Balanced hit rate (buyHit + sellHit) / 2, the drift-free figure the research verdicts use. */
  bh: number | null;
  /** Share of all calls that pointed the right way. */
  right: number | null;
  /** Mean of d x return over calls, before costs. */
  meanBefore: number | null;
  /** meanBefore minus the round-trip cost: the average result of acting on every call. */
  net: number | null;
  /** Share of calls with d x return above the cost. */
  wonAfterCost: number | null;
  /** Mean d x return of the calls that were right. */
  avgWin: number | null;
  /** Mean size of the move against the calls that were wrong, as a positive number. */
  avgLoss: number | null;
  /**
   * The right-share needed to break even after costs, holding these calls'
   * own average win and loss sizes fixed: (avgLoss + cost) / (avgWin + avgLoss).
   */
  breakEven: number | null;
}

export interface IntervalPair {
  lo: number;
  hi: number;
}

export interface MonthMeasures {
  /** UTC month of the signal bar, YYYY-MM. */
  month: string;
  calls: number;
  right: number | null;
  bh: number | null;
  net: number | null;
}

/** One symbol's year in one cell. Intervals are 95% moving-block bootstrap, block = horizonBars. */
export interface SymbolTrack {
  symbol: string;
  /** First and last signal bar with an outcome, epoch ms. */
  first: number;
  last: number;
  measures: PointMeasures;
  intervals: { right: IntervalPair | null; bh: IntervalPair | null; net: IntervalPair | null };
  months: MonthMeasures[];
}

/** All ten symbols pooled, copied from the re-score report (`v8-rescore-run.ts`), never recomputed. */
export interface PooledTrack {
  rows: number;
  buyN: number;
  sellN: number;
  bh: number;
  /** Interval at `level` (Bonferroni over the six cells). */
  bhLo: number;
  bhHi: number;
  net: number;
  netLo: number;
  netHi: number;
  spearman: number;
  level: number;
  verdict: string;
}

export interface CellParity {
  matched: number;
  sameTierShare: number | null;
  scoreCorrelation: number | null;
}

export interface CellTrack {
  style: TradingStyle;
  interval: string;
  horizonBars: number;
  costPercent: number;
  pooled: PooledTrack;
  parity: CellParity;
  symbols: SymbolTrack[];
}

export interface TrackRunMeta {
  runId: string;
  configVersion: number;
  /** Signal-bar window, ISO. */
  windowStart: string;
  windowEnd: string;
  cutoffs: { buy: number; strong: number };
  rowsSha256: string;
  reportSha256: string;
  gitCommit: string;
  /** The per-symbol bootstrap. */
  resamples: number;
  seed: number;
  loadedAt: string;
}

export interface TrackRun extends TrackRunMeta {
  cells: CellTrack[];
}

/** The scheduler's own record for the same symbol and cell, read from SignalOutcome. */
export interface LiveTrack {
  /** Earliest live signal bar at the re-score's configVersion, epoch ms; null when none exists. */
  since: number | null;
  resolved: number;
  pending: number;
  measures: PointMeasures;
}

export type TrackRecordUnavailableReason = 'not-scored' | 'no-run';

export type TrackRecordResponse =
  | { available: false; reason: TrackRecordUnavailableReason }
  | {
      available: true;
      run: TrackRunMeta;
      cell: Omit<CellTrack, 'symbols'>;
      symbol: SymbolTrack | null;
      live: LiveTrack;
      /**
       * Where the chart switches from re-scored bars to the live record: the
       * first live bar at the re-score's configVersion, or the bar after the
       * re-score's last when no live bar exists yet. Null when neither exists.
       */
      boundary: number | null;
      /** The scorer version running live now; differs from run.configVersion after a scorer bump. */
      liveConfigVersion: number;
    };

export interface TrackBarsResponse {
  available: boolean;
  boundary: number | null;
  horizonBars: number;
  costPercent: number;
  bars: TrackBar[];
}
