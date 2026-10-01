import type { OHLCV } from '@/types/market';
import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { getCandles } from '@/lib/candle-ingestion';
import { GlobalSignal } from '@/lib/models/global-signal';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { PaperBook, type IPaperBook } from '@/lib/models/paper-book';
import { PaperLedger, type IPaperLedger, type IPaperPosition } from '@/lib/models/paper-ledger';
import { PaperTrade, type PaperExitReason } from '@/lib/models/paper-trade';
import { buildSnapshotSeries, mapToSnapshotInterval, type LeanSnapshot } from '@/lib/backtest/snapshot-series';
import { intervalToMs } from '@/lib/intervals';
import { CRON_JOBS } from '@/lib/cron-jobs';
import { STOP_WINDOW_BARS, stopsFor, tradePlanConfig } from '@/lib/trade-plan/rule';
import { BOOK_START_EQUITY, DESK_BOOKS, bookId, type BookKey } from './books';
import { stepLedger } from './step';
import type { BarDecision, DeskPosition, FundingCharge, LedgerState, SignalTierOf } from './types';

/**
 * One run of the paper desk.
 *
 * Shape of the work, and why each part is the way it is:
 *
 * - **One cursor per book, and lockstep symbols.** The desk walks bar
 *   timestamps in ascending order and, inside each bar, every symbol in
 *   `SIGNAL_SYMBOLS` order. A per-symbol cursor would let a symbol that caught
 *   up late be sized against another symbol's later equity, so a result would
 *   depend on data arrival order rather than on the market.
 * - **The bar list is decided before any bar is stepped**, and stops at the
 *   first bar whose score may still arrive. A run therefore either steps a bar
 *   completely or not at all, and the cursor can advance to the last bar
 *   stepped without risk of re-stepping it next run.
 * - **A lease.** `withJobRun` takes no lock and the desk's cadence is one
 *   minute, while a catch-up run can take longer, so without one two runs
 *   could step the same bar twice.
 * - **Stops are re-derived per entry bar**, over the trailing
 *   `STOP_WINDOW_BARS` closed bars, exactly as the trade-plan ticket does.
 * - **Funding comes from the engine's own pinning**, so the desk and a replay
 *   cannot disagree about which rate applied to which bar.
 * - **No capacity cap.** Each (book, symbol) ledger is sized on its own
 *   equity, which is how every research run was sized; a portfolio cap would
 *   change which trades are taken and break that comparability. The aggregate
 *   leverage it implies is recorded on the book instead.
 */

/** Bars one run will step per book at most, so a long gap cannot run forever. */
export const MAX_CATCHUP_BARS = 240;

/** How long a run holds its lease: longer than a run should take, short enough to self-heal. */
export const LEASE_MS = 10 * 60 * 1000;

export interface BookRunReport {
  book: string;
  /** Bars stepped, or null when another run held the lease. */
  bars: number | null;
  symbols: number;
  opened: number;
  closed: number;
  /** Bars stepped where at least one symbol had no signal row. */
  missingScoreBars: number;
  /** Bars held back because their score may still arrive. */
  pendingBars: number;
  skippedEntries: number;
  capped: boolean;
  cursor: number | null;
  error?: string;
}

export interface PaperDeskReport {
  books: BookRunReport[];
  opened: number;
  closed: number;
  leasedOut: number;
  errors: number;
}

/** The compute-signals cadence for a style, read from the cron registry rather than restated. */
export function computeCadenceSeconds(style: TradingStyle): number {
  const spec = CRON_JOBS.find((j) => j.job === `compute-signals:${style}`);
  if (!spec) throw new Error(`No compute-signals cron registered for ${style}`);
  return spec.expectedEverySeconds;
}

/**
 * Whether a bar with no signal row should be treated as permanently unscored.
 *
 * `compute-signals` writes a row only for the latest closed bar of each run
 * (`compute-engine.ts:305-319`) and never backfills, so a missed run leaves a
 * hole that will never be filled, and waiting for it would stall the desk for
 * good. A bar is declared unscored once a later bar has been scored, or once
 * it is more than two compute cadences old.
 */
export function isUnscored(
  barCloseTime: number,
  latestScoredBar: number | null,
  now: number,
  cadenceSeconds: number
): boolean {
  if (latestScoredBar !== null && latestScoredBar >= barCloseTime) return true;
  return now - barCloseTime > 2 * cadenceSeconds * 1000;
}

interface SignalRow {
  candleTimestamp: number;
  score: number;
  tier: SignalTierOf;
  session: BarDecision['session'];
  configVersion: number;
  createdAt: Date;
}

interface SymbolRun {
  candles: OHLCV[];
  /** Funding rate per bar, index-matched to `candles`. */
  rates: (number | null)[];
  signals: Map<number, SignalRow>;
  latestScoredBar: number | null;
}

interface Live {
  state: LedgerState;
  /** Settlements charged against the open position, copied onto its trade at close. */
  charges: FundingCharge[];
  trades: number;
  /** configVersion of the signal that opened the current position. */
  entryConfigVersion: number;
}

/** Rebuilds the in-memory position from its stored document, against `refBar`. */
export function restorePosition(
  stored: IPaperPosition,
  candles: OHLCV[],
  refBar: number,
  intervalMs: number
): DeskPosition {
  const barOf = (time: number) => refBar - Math.round((candles[refBar].timestamp - time) / intervalMs);
  return {
    engine: {
      entryBar: barOf(stored.entryTime),
      entryTime: stored.entryTime,
      entryPrice: stored.entryPrice,
      side: stored.side,
      quantity: stored.quantity,
      entryScore: stored.entryScore,
      entryTier: stored.entryTier,
      entrySession: (stored.entrySession ?? null) as DeskPosition['engine']['entrySession'],
      entryFillKind: 'taker',
      fundingPnl: stored.fundingPnl,
      stopPrice: stored.stopPrice,
      targetPrice: stored.targetPrice,
      timeStopBars: stored.timeStopBars,
      entrySlippageCost: stored.entrySlippageCost,
    },
    executableEntryPrice: stored.executableEntryPrice,
    executableEntryBar: stored.executableEntryTime === null ? null : barOf(stored.executableEntryTime),
    signalCreatedAt: stored.signalCreatedAt,
  };
}

function toStoredPosition(
  position: DeskPosition,
  candles: OHLCV[],
  configVersion: number,
  charges: FundingCharge[]
): IPaperPosition {
  const e = position.engine;
  return {
    side: e.side,
    entryPrice: e.entryPrice,
    entryRawPrice: candles[e.entryBar]?.close ?? e.entryPrice,
    entryTime: e.entryTime,
    quantity: e.quantity,
    stopPrice: e.stopPrice,
    targetPrice: e.targetPrice,
    timeStopBars: e.timeStopBars,
    entrySlippageCost: e.entrySlippageCost,
    fundingPnl: e.fundingPnl ?? 0,
    entryScore: e.entryScore,
    entryTier: e.entryTier,
    entrySession: e.entrySession ?? null,
    entryConfigVersion: configVersion,
    signalCreatedAt: position.signalCreatedAt,
    executableEntryPrice: position.executableEntryPrice,
    executableEntryTime:
      position.executableEntryBar === null
        ? null
        : candles[position.executableEntryBar]?.timestamp ?? null,
    fundingCharges: charges,
  };
}

/** The exit reasons the rule can reach; `end_of_data` has no live counterpart. */
function paperExitReason(reason: string): PaperExitReason {
  if (reason === 'signal' || reason === 'stop_loss' || reason === 'take_profit' || reason === 'time_stop') {
    return reason;
  }
  throw new Error(`The paper desk cannot book an exit reason of ${reason}`);
}

/** Loads the candles, funding rates and signals one symbol needs for this run. */
async function loadSymbol(
  symbol: string,
  key: BookKey,
  windowBars: number
): Promise<SymbolRun | null> {
  const { tradingStyle, interval } = key;
  const candles = await getCandles(symbol, interval, undefined, undefined, windowBars);
  if (candles.length === 0) return null;
  const from = candles[0].timestamp;
  const snapshotInterval = mapToSnapshotInterval(interval);

  const snapshots = await HistoricalSnapshot.find({
    symbol,
    interval: snapshotInterval,
    timestamp: { $gte: from - 3 * intervalToMs(snapshotInterval) },
  })
    .sort({ timestamp: 1 })
    .lean<LeanSnapshot[]>();
  const series = buildSnapshotSeries(candles, snapshots, interval, { symbol });

  const rows = await GlobalSignal.find({ symbol, tradingStyle, interval, candleTimestamp: { $gte: from } })
    .sort({ candleTimestamp: 1, createdAt: 1 })
    .lean<SignalRow[]>();

  const signals = new Map<number, SignalRow>();
  let latestScoredBar: number | null = null;
  for (const row of rows) {
    // The earliest row for a bar wins: a duplicate is a second write of the
    // same decision, not a new one.
    if (!signals.has(row.candleTimestamp)) signals.set(row.candleTimestamp, row);
    latestScoredBar = Math.max(latestScoredBar ?? row.candleTimestamp, row.candleTimestamp);
  }

  return {
    candles,
    rates: series.map((s) => s?.futures?.fundingRate?.fundingRate ?? null),
    signals,
    latestScoredBar,
  };
}

/**
 * The bars this run will step: those after the cursor, in order, stopping at
 * the first whose score may still arrive.
 */
export function planBars(
  perSymbol: Map<string, SymbolRun>,
  cursor: number | null,
  intervalMs: number,
  now: number,
  cadenceSeconds: number
): { bars: number[]; pending: number; capped: boolean } {
  const all = new Set<number>();
  for (const { candles } of perSymbol.values()) {
    for (const c of candles) {
      if (cursor === null || c.timestamp > cursor) all.add(c.timestamp);
    }
  }
  let ordered = [...all].sort((a, b) => a - b);

  // First run: step only the newest bar. Replaying years of history here
  // would be a backtest, and the desk is a forward test.
  if (cursor === null) ordered = ordered.slice(-1);

  const ready: number[] = [];
  let pending = 0;
  for (const barTime of ordered) {
    const waiting = [...perSymbol.values()].some((data) => {
      const has = data.candles.some((c) => c.timestamp === barTime);
      if (!has || data.signals.has(barTime)) return false;
      return !isUnscored(barTime + intervalMs, data.latestScoredBar, now, cadenceSeconds);
    });
    if (waiting) {
      pending = ordered.length - ready.length;
      break;
    }
    ready.push(barTime);
  }

  let capped = false;
  let bars = ready;
  if (bars.length > MAX_CATCHUP_BARS) {
    bars = bars.slice(-MAX_CATCHUP_BARS);
    capped = true;
  }
  return { bars, pending, capped };
}

async function runBook(key: BookKey, now: number, owner: string): Promise<BookRunReport> {
  const { tradingStyle, interval } = key;
  const intervalMs = intervalToMs(interval);
  const report: BookRunReport = {
    book: bookId(key),
    bars: 0,
    symbols: 0,
    opened: 0,
    closed: 0,
    missingScoreBars: 0,
    pendingBars: 0,
    skippedEntries: 0,
    capped: false,
    cursor: null,
  };

  await PaperBook.updateOne(
    { tradingStyle, interval },
    { $setOnInsert: { startEquity: BOOK_START_EQUITY, lastProcessedBarTime: null } },
    { upsert: true }
  );
  const leased = await PaperBook.findOneAndUpdate(
    { tradingStyle, interval, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date(now) } }] },
    { $set: { leaseUntil: new Date(now + LEASE_MS), leaseOwner: owner } },
    { new: true }
  ).lean<IPaperBook | null>();
  if (!leased) return { ...report, bars: null };

  // Report where the book already stands, so a run that advances nothing
  // still says where it is rather than reading as "no cursor".
  report.cursor = leased.lastProcessedBarTime;

  let leaseHeld = true;
  try {
    const cadenceSeconds = computeCadenceSeconds(tradingStyle);
    const windowBars = STOP_WINDOW_BARS + MAX_CATCHUP_BARS + 2;

    const perSymbol = new Map<string, SymbolRun>();
    for (const symbol of SIGNAL_SYMBOLS) {
      const loaded = await loadSymbol(symbol, key, windowBars);
      if (loaded) perSymbol.set(symbol, loaded);
    }
    report.symbols = perSymbol.size;
    if (perSymbol.size === 0) return report;

    const plan = planBars(perSymbol, leased.lastProcessedBarTime, intervalMs, now, cadenceSeconds);
    report.pendingBars = plan.pending;
    report.capped = plan.capped;
    if (plan.bars.length === 0) return report;

    const docs = await PaperLedger.find({ tradingStyle, interval }).lean<IPaperLedger[]>();
    const stored = new Map(docs.map((d) => [d.symbol, d]));

    // Equity is DERIVED from the trades that closed AT OR BEFORE the cursor,
    // not carried forward as a running total.
    //
    // Two things follow. A replay of the same bars starts from the same
    // equity it started from the first time, so it sizes identically and
    // re-books byte-identical trades onto their natural key instead of
    // doubling the pnl. And the ledger becomes a projection of the trade log,
    // which is the durable record, so a cursor rollback heals itself.
    const banked = await PaperTrade.aggregate<{
      _id: string;
      engine: number;
      executable: number;
      trades: number;
    }>([
      {
        $match: {
          tradingStyle,
          interval,
          ...(leased.lastProcessedBarTime === null
            ? {}
            : { exitTime: { $lte: leased.lastProcessedBarTime } }),
        },
      },
      {
        $group: {
          _id: '$symbol',
          engine: { $sum: '$engine.pnl' },
          executable: { $sum: { $cond: ['$executable.filled', '$executable.pnl', 0] } },
          trades: { $sum: 1 },
        },
      },
    ]);
    const bankedBySymbol = new Map(banked.map((b) => [b._id, b]));

    // Restore each ledger once, against the first bar this run will step.
    const live = new Map<string, Live>();
    const firstBarTime = plan.bars[0];
    for (const [symbol, data] of perSymbol) {
      const doc = stored.get(symbol);
      const refBar = data.candles.findIndex((c) => c.timestamp === firstBarTime);
      const position =
        doc?.position && refBar !== -1
          ? restorePosition(doc.position, data.candles, refBar, intervalMs)
          : null;
      const bank = bankedBySymbol.get(symbol);
      live.set(symbol, {
        state: {
          equity: BOOK_START_EQUITY + (bank?.engine ?? 0),
          executableEquity: BOOK_START_EQUITY + (bank?.executable ?? 0),
          position,
        },
        charges: position ? [...(doc?.position?.fundingCharges ?? [])] : [],
        trades: bank?.trades ?? 0,
        entryConfigVersion: doc?.position?.entryConfigVersion ?? 0,
      });
    }

    let peakNotional = leased.peakNotional;
    let peakLeverage = leased.peakLeverage;
    let missingScoreBars = 0;

    for (const barTime of plan.bars) {
      let barHadMissingScore = false;

      for (const symbol of SIGNAL_SYMBOLS) {
        const data = perSymbol.get(symbol);
        if (!data) continue;
        const bar = data.candles.findIndex((c) => c.timestamp === barTime);
        if (bar === -1) continue;

        const entry = live.get(symbol)!;
        const row = data.signals.get(barTime);
        if (!row) barHadMissingScore = true;

        const decision: BarDecision = row
          ? {
              scored: true,
              score: row.score,
              tier: row.tier,
              session: row.session,
              signalCreatedAt: new Date(row.createdAt).getTime(),
            }
          : { scored: false, score: 0, tier: 'neutral', session: null, signalCreatedAt: null };

        const stops = stopsFor(data.candles.slice(0, bar + 1));
        const config = tradePlanConfig(tradingStyle, interval, stops, entry.state.equity);
        const had = entry.state.position !== null;

        const out = stepLedger(entry.state, {
          candles: data.candles,
          bar,
          interval,
          decision,
          fundingRate: data.rates[bar] ?? null,
          config,
        });

        if (out.funding) entry.charges.push(out.funding);
        if (out.skipped === 'session_filtered') report.skippedEntries++;

        for (const trade of out.closed) {
          await bookTrade(key, symbol, trade, entry.charges, entry.entryConfigVersion);
          // Counted like the equity: trades banked before the cursor plus
          // those closed in this run, so a replay lands on the same number.
          entry.trades++;
          entry.charges = [];
          report.closed++;
        }

        if (out.state.position && (!had || out.closed.length > 0)) {
          report.opened++;
          entry.entryConfigVersion = row?.configVersion ?? 0;
        }
        entry.state = out.state;
      }

      // Aggregate exposure, measured once the whole bar has stepped.
      let notional = 0;
      let equity = 0;
      for (const [symbol, entry] of live) {
        const data = perSymbol.get(symbol)!;
        const bar = data.candles.findIndex((c) => c.timestamp === barTime);
        equity += entry.state.equity;
        if (entry.state.position && bar !== -1) {
          notional += entry.state.position.engine.quantity * data.candles[bar].close;
        }
      }
      if (notional > peakNotional) peakNotional = notional;
      const leverage = equity > 0 ? notional / equity : 0;
      if (leverage > peakLeverage) peakLeverage = leverage;

      if (barHadMissingScore) missingScoreBars++;
      report.bars = (report.bars ?? 0) + 1;
      report.cursor = barTime;
    }

    report.missingScoreBars = missingScoreBars;

    for (const [symbol, entry] of live) {
      const candles = perSymbol.get(symbol)!.candles;
      await PaperLedger.updateOne(
        { tradingStyle, interval, symbol },
        {
          $set: {
            equity: entry.state.equity,
            executableEquity: entry.state.executableEquity,
            trades: entry.trades,
            position: entry.state.position
              ? toStoredPosition(entry.state.position, candles, entry.entryConfigVersion, entry.charges)
              : null,
          },
        },
        { upsert: true }
      );
    }

    // The cursor advances and the lease clears in one write, so a crash
    // between them cannot leave a book both advanced and locked.
    await PaperBook.updateOne(
      { tradingStyle, interval },
      {
        $set: {
          lastProcessedBarTime: report.cursor,
          peakNotional,
          peakLeverage,
          leaseUntil: null,
          leaseOwner: null,
        },
        $inc: { missingScoreBars },
      }
    );
    leaseHeld = false;
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    // A failed run must not wedge the book.
    if (leaseHeld) {
      await PaperBook.updateOne(
        { tradingStyle, interval },
        { $set: { leaseUntil: null, leaseOwner: null } }
      );
    }
  }
}

/** Upserts one closed trade on its natural key, so a repeated run cannot book it twice. */
async function bookTrade(
  key: BookKey,
  symbol: string,
  trade: { engine: import('@/lib/backtest/types').BacktestTrade; executable: import('./types').ExecutableFill },
  charges: FundingCharge[],
  entryConfigVersion: number
): Promise<void> {
  const t = trade.engine;
  await PaperTrade.updateOne(
    { tradingStyle: key.tradingStyle, interval: key.interval, symbol, entryTime: t.entryTime },
    {
      $set: {
        side: t.side,
        quantity: t.quantity,
        exitTime: t.exitTime,
        holdTimeBars: t.holdTimeBars,
        exitReason: paperExitReason(t.exitReason),
        entryScore: t.entryScore ?? 0,
        exitScore: t.exitScore,
        entryTier: t.entryTier ?? 'neutral',
        entrySession: t.entrySession ?? null,
        entryConfigVersion,
        riskPercent: t.riskPercent,
        rewardPercent: t.rewardPercent,
        fundingCost: t.fundingCost,
        fundingCharges: charges,
        engine: {
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          fees: t.fees,
          slippageCost: t.slippageCost,
          pnl: t.pnl,
          pnlPercent: t.pnlPercent,
        },
        executable: {
          entryPrice: trade.executable.entryPrice,
          exitPrice: trade.executable.exitPrice,
          fees: trade.executable.fees,
          slippageCost: trade.executable.slippageCost,
          pnl: trade.executable.pnl,
          pnlPercent: trade.executable.pnlPercent,
          filled: trade.executable.filled,
          entryDelayBars: trade.executable.entryDelayBars,
          gappedStop: trade.executable.gappedStop,
          stoppedOnArrival: trade.executable.stoppedOnArrival,
        },
      },
    },
    { upsert: true }
  );
}

export async function runPaperDesk(now: number = Date.now(), owner = `run-${now}`): Promise<PaperDeskReport> {
  const books: BookRunReport[] = [];
  for (const key of DESK_BOOKS) {
    books.push(await runBook(key, now, owner));
  }
  return {
    books,
    opened: books.reduce((s, b) => s + b.opened, 0),
    closed: books.reduce((s, b) => s + b.closed, 0),
    leasedOut: books.filter((b) => b.bars === null).length,
    errors: books.filter((b) => b.error).length,
  };
}
