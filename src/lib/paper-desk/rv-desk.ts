import { fetchPerpKlinesRange } from '@/lib/binance-futures';
import { syncFundingSettlements } from '@/lib/funding-settlement-sync';
import { connectDB } from '@/lib/mongodb';
import { retryOnce, RETRY_ONCE_DELAY_MS } from '@/lib/retry-once';
import { FundingSettlement, type IFundingSettlement } from '@/lib/models/funding-settlement';
import {
  RvBook,
  RV_BOOK_NAME,
  type IRvBook,
  type RvBookState,
  type RvFillBucketKey,
  type RvFillStats,
} from '@/lib/models/rv-book';
import { RvSignal, type IRvSignal } from '@/lib/models/rv-signal';
import { RvStep, type IRvStep } from '@/lib/models/rv-step';
import {
  RV_V1,
  RvDataError,
  rvInitialState,
  rvStep,
  rvTargets,
  type RvFillBar,
  type RvSettlement,
  type RvStepRecord,
  type RvTrackState,
} from '@/lib/signals/cross-sectional/engine';

/**
 * The rv-v1 paper desk: steps the book over each stored rv-v1 signal, in
 * order, on two cost tracks.
 *
 * - **A lease** taken with one atomic findOneAndUpdate, so two runs can never
 *   step the same signal (D09). The final book write is filtered on the
 *   owner, so a run that lost its lease cannot overwrite the book.
 * - **Forward only.** A book with no cursor steps only the newest signal;
 *   replaying history would be a backtest, and this is a forward record.
 * - **State from the step log.** Each RvStep stores the book state after it,
 *   and a run restores from the step at the cursor. A replay after a crash or
 *   a cursor rollback therefore recomputes byte-identical steps, upserted on
 *   (bookName, barTime) so none is added twice.
 * - **A data failure never trades.** A held symbol missing from the ranking,
 *   a fill bar that cannot be fetched or a funding settlement that cannot be
 *   found leaves the step pending with its reason and stops the run there.
 *   The route answers 500 once a step has been pending for a full cadence.
 * - **Alerts are flags only.** A drawdown or a losing streak is recorded on
 *   the book and never stops trading.
 */

/** How long a run holds its lease: far longer than a run takes, short enough to self-heal. */
export const LEASE_MS = 10 * 60 * 1000;
/** A signal is ready once the first 1h bar after its close has closed, plus a margin. */
export const READY_DELAY_MS = RV_V1.makerWindowMs + 2 * 60 * 1000;
/** A step pending longer than one cadence past its ready time fails the run. */
export const STALE_PENDING_MS = RV_V1.barMs;
/** Drawdown from the track's peak that raises its alert flag. */
export const DRAWDOWN_ALERT = 0.15;
/** Steps one run takes at most, so a long outage drains over several runs inside the lease. */
export const MAX_STEPS_PER_RUN = 12;

export interface RvDeskOptions {
  /** Pause before the single fill-bar retry. */
  retryDelayMs?: number;
}

export interface RvPendingStep {
  barTime: number;
  reasons: string[];
}

export type RvDeskReport =
  | { leased: false; stepped: 0 }
  | {
      leased: true;
      stepped: number;
      pending: RvPendingStep[];
      /** barTime of the newest signal stepped, null before the first. */
      cursor: number | null;
      /** Signals stored but not yet ready to step. */
      waiting: number;
      /** The run stopped at MAX_STEPS_PER_RUN with ready signals left. */
      capped: boolean;
      /** A step has been pending for more than one cadence past its ready time. */
      stalePending: boolean;
    };

const FILL_HOURS: Record<number, RvFillBucketKey> = { 0: '00', 8: '08', 16: '16' };

function emptyFillStats(): RvFillStats {
  const bucket = () => ({ makerFilled: 0, makerFallback: 0, steps: 0 });
  return { '00': bucket(), '08': bucket(), '16': bucket(), weekday: bucket(), weekend: bucket() };
}

function initialBookState(): RvBookState {
  const equity = RV_V1.startingEquity;
  return {
    tracks: { taker: rvInitialState(), maker: rvInitialState() },
    equity: { taker: equity, maker: equity },
    peakEquity: { taker: equity, maker: equity },
    alerts: { drawdownTaker: false, drawdownMaker: false, negativeStreak: 0 },
    fillStats: emptyFillStats(),
  };
}

function heldSymbols(state: RvTrackState): string[] {
  return Object.entries(state.positions)
    .filter(([, p]) => p.qty !== 0)
    .map(([symbol]) => symbol);
}

function fillTimeFacts(fillTime: number): { rebalanceHourUtc: number; isWeekend: boolean } {
  const date = new Date(fillTime);
  const day = date.getUTCDay();
  return { rebalanceHourUtc: date.getUTCHours(), isWeekend: day === 0 || day === 6 };
}

/** The book state after one step: tracks, equity, peaks, alert flags and fill counts. */
function nextBookState(
  prev: RvBookState,
  taker: { state: RvTrackState; record: RvStepRecord },
  maker: { state: RvTrackState; record: RvStepRecord },
  fillTime: number
): RvBookState {
  const equity = { taker: taker.record.equityAfter, maker: maker.record.equityAfter };
  const peakEquity = {
    taker: Math.max(prev.peakEquity.taker, equity.taker),
    maker: Math.max(prev.peakEquity.maker, equity.maker),
  };

  const { rebalanceHourUtc, isWeekend } = fillTimeFacts(fillTime);
  const hourKey = FILL_HOURS[rebalanceHourUtc];
  if (!hourKey) throw new Error(`rv desk: fillTime ${fillTime} is not on an 8h boundary`);
  const fillStats: RvFillStats = structuredClone(prev.fillStats);
  for (const key of [hourKey, isWeekend ? 'weekend' : 'weekday'] as const) {
    const bucket = fillStats[key];
    bucket.steps += 1;
    for (const fill of maker.record.fills) {
      if (fill.kind === 'maker') bucket.makerFilled += 1;
      else if (fill.kind === 'taker_fallback') bucket.makerFallback += 1;
    }
  }

  return {
    tracks: { taker: taker.state, maker: maker.state },
    equity,
    peakEquity,
    alerts: {
      drawdownTaker: equity.taker <= peakEquity.taker * (1 - DRAWDOWN_ALERT),
      drawdownMaker: equity.maker <= peakEquity.maker * (1 - DRAWDOWN_ALERT),
      // Step on step: within one step equity only ever falls by the costs paid
      negativeStreak: equity.taker < prev.equity.taker ? prev.alerts.negativeStreak + 1 : 0,
    },
    fillStats,
  };
}

type StepOutcome =
  | { ok: true; targets: Record<string, number>; taker: RvStepRecord; maker: RvStepRecord; bookAfter: RvBookState }
  | { ok: false; targets: Record<string, number> | null; reasons: string[] };

function dataErrorReason(err: RvDataError): string {
  return `${err.code}: ${err.message}`;
}

/** Settlement boundaries a held leg must have crossed: every 8h boundary in (prevFillTime, fillTime]. */
function requiredBoundaries(prevFillTime: number, fillTime: number): number[] {
  const out: number[] = [];
  for (let t = fillTime; t > prevFillTime; t -= RV_V1.barMs) out.push(t);
  return out;
}

async function loadSettlements(
  symbols: string[],
  prevFillTime: number,
  fillTime: number
): Promise<{ bySymbol: Record<string, RvSettlement[]>; missing: string[] }> {
  const rows = await FundingSettlement.find({
    symbol: { $in: symbols },
    fundingTime: { $gt: prevFillTime, $lte: fillTime },
  })
    .sort({ fundingTime: 1 })
    .lean<IFundingSettlement[]>();
  const bySymbol: Record<string, RvSettlement[]> = {};
  for (const symbol of symbols) bySymbol[symbol] = [];
  for (const r of rows) {
    // Archive rows written before markPrice existed lack it: unknown, so the engine uses the last mark
    bySymbol[r.symbol].push({ fundingTime: r.fundingTime, rate: r.rate, markPrice: r.markPrice ?? null });
  }
  const required = requiredBoundaries(prevFillTime, fillTime);
  const missing = symbols.filter((symbol) => {
    const times = new Set(bySymbol[symbol].map((s) => s.fundingTime));
    return required.some((t) => !times.has(t));
  });
  return { bySymbol, missing };
}

async function stepSignal(
  signal: IRvSignal,
  prev: RvBookState,
  prevFillTime: number | null,
  now: number,
  retryDelayMs: number
): Promise<StepOutcome> {
  const fillTime = signal.barCloseTime;

  // Targets from the ranking and the legs the taker track holds
  const held = new Map<string, 1 | -1>();
  for (const [symbol, p] of Object.entries(prev.tracks.taker.positions)) {
    if (p.qty !== 0) held.set(symbol, p.qty > 0 ? 1 : -1);
  }
  const betas = new Map(signal.rows.map((r) => [r.symbol, r.beta]));
  let targets: Record<string, number>;
  try {
    targets = Object.fromEntries(rvTargets(signal.ranked, held, betas));
  } catch (err) {
    if (err instanceof RvDataError) return { ok: false, targets: null, reasons: [dataErrorReason(err)] };
    throw err;
  }

  const heldAny = [...new Set([...heldSymbols(prev.tracks.taker), ...heldSymbols(prev.tracks.maker)])].sort();
  const symbols = [...new Set([...Object.keys(targets), ...heldAny])].sort();

  // The first 1h perp bar opening at fillTime. Absent at the venue means null
  // (the engine marks the leg stale or skips the entry); a failed fetch is not
  // absence, so it waits for the next run instead.
  const fillBars: Record<string, RvFillBar | null> = {};
  const unavailable: string[] = [];
  for (const symbol of symbols) {
    try {
      const klines = await retryOnce(() => fetchPerpKlinesRange(symbol, '1h', fillTime, fillTime), retryDelayMs);
      const bar = klines.find((k) => k.openTime === fillTime);
      fillBars[symbol] = bar ? { open: bar.open, high: bar.high, low: bar.low, close: bar.close } : null;
    } catch {
      // The reason carries the symbol; the step is retried next run
      unavailable.push(`fill_bar_unavailable:${symbol}`);
    }
  }
  if (unavailable.length > 0) return { ok: false, targets, reasons: unavailable };

  // Funding for every settlement each held leg crossed since the last fill (D16)
  let settlements: Record<string, RvSettlement[]> = {};
  if (prevFillTime !== null && heldAny.length > 0) {
    let loaded = await loadSettlements(heldAny, prevFillTime, fillTime);
    if (loaded.missing.length > 0) {
      await syncFundingSettlements(heldAny, now);
      loaded = await loadSettlements(heldAny, prevFillTime, fillTime);
    }
    if (loaded.missing.length > 0) {
      return { ok: false, targets, reasons: loaded.missing.map((s) => `funding_missing:${s}`) };
    }
    settlements = loaded.bySymbol;
  }

  try {
    const common = { prevFillTime, fillTime, fillBars, settlements, targets };
    const taker = rvStep(prev.tracks.taker, { track: 'taker', ...common });
    const maker = rvStep(prev.tracks.maker, { track: 'maker', ...common });
    return {
      ok: true,
      targets,
      taker: taker.record,
      maker: maker.record,
      bookAfter: nextBookState(prev, taker, maker, fillTime),
    };
  } catch (err) {
    if (err instanceof RvDataError) return { ok: false, targets, reasons: [dataErrorReason(err)] };
    throw err;
  }
}

export async function runRvDesk(now: number, owner: string, opts: RvDeskOptions = {}): Promise<RvDeskReport> {
  await connectDB();
  const bookName = RV_BOOK_NAME;
  const initial = initialBookState();

  await RvBook.updateOne(
    { bookName },
    {
      $setOnInsert: {
        bookName,
        version: RV_V1.version,
        validationStatus: 'unvalidated',
        validationRef: null,
        startedAt: new Date(now),
        startBarTime: null,
        lastStepBarTime: null,
        leaseUntil: null,
        leaseOwner: null,
        ...initial,
      },
    },
    { upsert: true }
  );
  const leased = await RvBook.findOneAndUpdate(
    { bookName, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date(now) } }] },
    { $set: { leaseUntil: new Date(now + LEASE_MS), leaseOwner: owner } },
    { new: true }
  ).lean<IRvBook | null>();
  if (!leased) return { leased: false, stepped: 0 };

  let leaseHeld = true;
  try {
    const cursor = leased.lastStepBarTime;
    let state: RvBookState = initial;
    let prevFillTime: number | null = null;
    if (cursor !== null) {
      const atCursor = await RvStep.findOne({ bookName, barTime: cursor }).lean<IRvStep | null>();
      if (!atCursor?.bookAfter || atCursor.pendingReasons.length > 0) {
        throw new Error(`rv desk: no completed RvStep at the cursor ${cursor}`);
      }
      state = atCursor.bookAfter;
      prevFillTime = atCursor.fillTime;
    }

    // Forward only: a book with no cursor starts from the newest signal
    const signals =
      cursor === null
        ? await RvSignal.find({ version: RV_V1.version }).sort({ barTime: -1 }).limit(1).lean<IRvSignal[]>()
        : await RvSignal.find({ version: RV_V1.version, barTime: { $gt: cursor } })
            .sort({ barTime: 1 })
            .lean<IRvSignal[]>();

    const report = {
      leased: true as const,
      stepped: 0,
      pending: [] as RvPendingStep[],
      cursor,
      waiting: 0,
      capped: false,
      stalePending: false,
    };
    let startBarTime = leased.startBarTime;
    const retryDelayMs = opts.retryDelayMs ?? RETRY_ONCE_DELAY_MS;

    for (let i = 0; i < signals.length; i++) {
      const signal = signals[i];
      const fillTime = signal.barCloseTime;
      const readyTime = fillTime + READY_DELAY_MS;
      if (now < readyTime) {
        report.waiting = signals.length - i;
        break;
      }
      if (report.stepped >= MAX_STEPS_PER_RUN) {
        report.capped = true;
        break;
      }

      const outcome = await stepSignal(signal, state, prevFillTime, now, retryDelayMs);
      const key = { bookName, barTime: signal.barTime };
      const facts = fillTimeFacts(fillTime);
      if (!outcome.ok) {
        await RvStep.updateOne(
          key,
          {
            $set: {
              fillTime,
              targets: outcome.targets,
              taker: null,
              maker: null,
              bookAfter: null,
              ...facts,
              pendingReasons: outcome.reasons,
            },
          },
          { upsert: true }
        );
        report.pending.push({ barTime: signal.barTime, reasons: outcome.reasons });
        report.stalePending = now - readyTime > STALE_PENDING_MS;
        break;
      }

      await RvStep.updateOne(
        key,
        {
          $set: {
            fillTime,
            targets: outcome.targets,
            taker: outcome.taker,
            maker: outcome.maker,
            bookAfter: outcome.bookAfter,
            ...facts,
            pendingReasons: [],
          },
        },
        { upsert: true }
      );
      if (report.cursor === null) startBarTime = signal.barTime;
      state = outcome.bookAfter;
      prevFillTime = fillTime;
      report.cursor = signal.barTime;
      report.stepped += 1;
    }

    // The cursor, the projected state and the lease release land in one write
    const written = await RvBook.updateOne(
      { bookName, leaseOwner: owner },
      {
        $set: {
          ...state,
          lastStepBarTime: report.cursor,
          startBarTime,
          leaseUntil: null,
          leaseOwner: null,
        },
      }
    );
    if (written.matchedCount !== 1) {
      throw new Error(`rv desk: lease lost by ${owner} before the book could be written`);
    }
    leaseHeld = false;
    return report;
  } finally {
    // A failed run releases its own lease, never another run's
    if (leaseHeld) {
      await RvBook.updateOne({ bookName, leaseOwner: owner }, { $set: { leaseUntil: null, leaseOwner: null } });
    }
  }
}
