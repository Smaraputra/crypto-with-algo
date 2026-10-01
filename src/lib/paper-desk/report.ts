import type { IPaperTrade } from '@/lib/models/paper-trade';
import { bootstrapCi } from '@/lib/stats/block-bootstrap';
import { evidenceFor } from '@/lib/trade-plan/evidence';
import { normalQuantile } from '@/lib/stats/normal';
import { BOOK_START_EQUITY, DESK_READ_RULE, bookId, type BookKey } from './books';

/**
 * Per-book statistics over the desk's closed trades.
 *
 * Shared by the ops script and the admin API so the CLI and the dashboard can
 * never come to disagree about what "expectancy" means, the same reason
 * `defaultCostPercent` has one home.
 *
 * Win rate is DESCRIPTIVE only, per the standing programme decision: a rule
 * can win most of its trades and still lose money, so it is shown and never
 * read as a verdict. The verdict is `readRule`, declared in `books.ts` before
 * any v8 trade existed.
 */

export interface TrackStats {
  trades: number;
  expectancyPercent: number;
  ciLowPercent: number;
  ciHighPercent: number;
  winRate: number;
  totalPnl: number;
}

export interface BookReport {
  book: string;
  trades: number;
  symbols: number;
  /** Equity summed across the book's ledgers, against its nominal start. */
  equity: number;
  executableEquity: number;
  startEquity: number;
  engine: TrackStats | null;
  executable: TrackStats | null;
  /** Mean per-trade difference between the tracks, in percent: the cost of the lag. */
  lagCostPercent: number | null;
  byReason: Record<string, number>;
  gappedStops: number;
  stoppedOnArrival: number;
  unfilled: number;
  missingScoreBars: number;
  peakLeverage: number;
  openPositions: number;
  /** What the research record says about this rule at this interval. */
  recordedExpectancyPercent: number | null;
  evidenceStatus: string;
  /** The pre-declared read rule (`DESK_READ_RULE`), evaluated on the executable track. */
  readRule: ReadRuleState;
}

export interface ReadRuleState {
  declaredOn: string;
  /** Executable trades needed to detect DESK_READ_RULE.deltaPercent; null with no recorded sd. */
  requiredTrades: number | null;
  /** `requiredTrades` at the recorded trades a day, for scale; null when either is unknown. */
  daysAtRecordedRate: number | null;
  executableTrades: number;
  /** The executable track's whole 95% interval is below zero: the edge read is closed. */
  futility: boolean;
  /** `not_yet` until the count is reached, then read once: `pass` or `fail`. */
  goLive: 'not_yet' | 'pass' | 'fail' | 'no_count';
  /** Executable trades reached DESK_READ_RULE.executionReadMinTrades. */
  executionReadReady: boolean;
}

/** Bootstrap block length: a few trades, so neighbouring trades stay together. */
const BLOCK_LENGTH = 5;
const BOOTSTRAP_ITERATIONS = 2000;
const BOOTSTRAP_SEED = 42;

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

/**
 * Trades needed to detect a per-trade edge of `deltaPercent` at one-sided
 * `alpha` with `power`, for a per-trade sd of `sdPercent` (all percent):
 * n = ((z(1 - alpha) + z(power)) x sd / delta)^2, rounded up.
 */
export function requiredTrades(sdPercent: number, deltaPercent: number, alpha: number, power: number): number {
  const z = normalQuantile(1 - alpha) + normalQuantile(power);
  return Math.ceil(((z * sdPercent) / deltaPercent) ** 2);
}

/** The read rule's state for one book, from its executable track and the recorded evidence. */
export function readRuleState(interval: string, executable: TrackStats | null): ReadRuleState {
  const evidence = evidenceFor(interval);
  const rule = DESK_READ_RULE;
  const required =
    evidence.sdPercentEffective !== null && evidence.sdPercentEffective > 0
      ? requiredTrades(evidence.sdPercentEffective, rule.deltaPercent, rule.alphaOneSided, rule.power)
      : null;
  const trades = executable?.trades ?? 0;
  let goLive: ReadRuleState['goLive'] = 'no_count';
  if (required !== null) {
    if (trades < required) goLive = 'not_yet';
    else goLive = executable !== null && executable.ciLowPercent > 0 ? 'pass' : 'fail';
  }
  return {
    declaredOn: rule.declaredOn,
    requiredTrades: required,
    daysAtRecordedRate:
      required !== null && evidence.tradesPerDay !== null && evidence.tradesPerDay > 0
        ? required / evidence.tradesPerDay
        : null,
    executableTrades: trades,
    futility: executable !== null && executable.ciHighPercent < 0,
    goLive,
    executionReadReady: trades >= rule.executionReadMinTrades,
  };
}

export function trackStats(returns: number[], pnls: number[]): TrackStats | null {
  if (returns.length === 0) return null;
  const ci = bootstrapCi(returns, mean, {
    iterations: BOOTSTRAP_ITERATIONS,
    meanBlockLen: BLOCK_LENGTH,
    seed: BOOTSTRAP_SEED,
  });
  return {
    trades: returns.length,
    expectancyPercent: ci.point,
    ciLowPercent: ci.low,
    ciHighPercent: ci.high,
    winRate: returns.filter((r) => r > 0).length / returns.length,
    totalPnl: pnls.reduce((s, x) => s + x, 0),
  };
}

/** How long a count takes at the recorded rate, in days or, past two years, in years. */
function horizon(days: number): string {
  return days < 730
    ? `about ${Math.round(days).toLocaleString('en-US')} days`
    : `about ${Math.round(days / 365).toLocaleString('en-US')} years`;
}

/** A book's read-rule state, as plain sentences for the CLI and the dashboard. */
export function describeReadRule(rule: ReadRuleState): string {
  const count =
    rule.requiredTrades === null
      ? 'No recorded sd, so no trade count.'
      : `Needs ${rule.requiredTrades.toLocaleString('en-US')} executable trades` +
        (rule.daysAtRecordedRate === null ? '.' : ` (${horizon(rule.daysAtRecordedRate)} at the recorded rate).`);
  const verdict = rule.futility
    ? 'FUTILITY: the executable interval is below zero, so the edge read is closed.'
    : rule.goLive === 'not_yet'
      ? `Go-live not yet read, ${rule.executableTrades} so far.`
      : rule.goLive === 'pass'
        ? 'Go-live read: PASS.'
        : rule.goLive === 'fail'
          ? 'Go-live read: FAIL.'
          : 'Go-live cannot be read.';
  const execution = rule.executionReadReady
    ? 'Execution read ready.'
    : `Execution read after ${DESK_READ_RULE.executionReadMinTrades} executable trades.`;
  return `${count} ${verdict} ${execution}`;
}

export function buildBookReport(
  key: BookKey,
  trades: IPaperTrade[],
  ledgers: Array<{ equity: number; executableEquity: number; position: unknown }>,
  book: { missingScoreBars: number; peakLeverage: number } | null
): BookReport {
  const engineReturns = trades.map((t) => t.engine.pnlPercent);
  const filledTrades = trades.filter((t) => t.executable.filled);
  const executableStats = trackStats(
    filledTrades.map((t) => t.executable.pnlPercent),
    filledTrades.map((t) => t.executable.pnl)
  );
  const enginePnls = trades.map((t) => t.engine.pnl);
  const filled = trades.filter((t) => t.executable.filled);

  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;

  return {
    book: bookId(key),
    trades: trades.length,
    symbols: ledgers.length,
    equity: ledgers.reduce((s, l) => s + l.equity, 0),
    executableEquity: ledgers.reduce((s, l) => s + l.executableEquity, 0),
    startEquity: ledgers.length * BOOK_START_EQUITY,
    engine: trackStats(engineReturns, enginePnls),
    executable: executableStats,
    lagCostPercent:
      filled.length === 0
        ? null
        : mean(filled.map((t) => t.engine.pnlPercent - t.executable.pnlPercent)),
    byReason,
    gappedStops: trades.filter((t) => t.executable.gappedStop).length,
    stoppedOnArrival: trades.filter((t) => t.executable.stoppedOnArrival).length,
    unfilled: trades.length - filled.length,
    missingScoreBars: book?.missingScoreBars ?? 0,
    peakLeverage: book?.peakLeverage ?? 0,
    openPositions: ledgers.filter((l) => l.position !== null).length,
    recordedExpectancyPercent: evidenceFor(key.interval).expectancyPercent,
    evidenceStatus: evidenceFor(key.interval).status,
    readRule: readRuleState(key.interval, executableStats),
  };
}


/**
 * A realised equity curve for one book, derived from its closed trades.
 *
 * One point per closed trade, at the moment it closed. It is NOT a bar-by-bar
 * mark-to-market curve: an open position's unrealised swing is invisible here,
 * so the curve understates the drawdown actually lived through. It answers
 * "what has this book banked, and in what order", which is the question the
 * forward test is for.
 */
export function equityCurveFromTrades(
  trades: Array<Pick<IPaperTrade, 'exitTime'> & { pnl: number }>,
  startEquity: number
): Array<{ bar: number; time: number; equity: number; drawdown: number }> {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let equity = startEquity;
  let peak = startEquity;
  return ordered.map((trade, i) => {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    return {
      bar: i,
      time: trade.exitTime,
      equity,
      drawdown: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
    };
  });
}
