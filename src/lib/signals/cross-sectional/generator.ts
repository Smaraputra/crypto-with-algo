import type { OHLCV } from '@/types/market';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { fetchPerpKlines } from '@/lib/binance-futures';
import { syncFundingSettlements } from '@/lib/funding-settlement-sync';
import { connectDB } from '@/lib/mongodb';
import { retryOnce, RETRY_ONCE_DELAY_MS } from '@/lib/retry-once';
import { FundingSettlement, type IFundingSettlement } from '@/lib/models/funding-settlement';
import { RvBook, RV_BOOK_NAME, type IRvBook } from '@/lib/models/rv-book';
import { RvSignal, type IRvSignal, type RvSignalSettlementInput } from '@/lib/models/rv-signal';
import type {
  ICrossSectionalSnapshot,
  ICrossSectionalRank,
  ICrossSectionalTarget,
} from '@/lib/models/cross-sectional-signal';
import {
  computeCrossSectionalRanks,
  type FactorScores,
  type FactorWeights,
  type SymbolBarSnapshot,
} from './factors';
import { constructBufferedPortfolio, type TargetAllocation } from './portfolio';
import {
  RV_V1,
  RvDataError,
  rvComposite,
  rvFactors,
  type RvBar,
  type RvFactorResult,
  type RvRanked,
  type RvSymbolInput,
} from './engine';

// ------------------------------------------------------------------ rv-v1 signal job

/** Bars requested per symbol: 43 closed bars are needed, plus the in-progress one and a spare. */
export const RV_SIGNAL_KLINE_LIMIT = 45;

/** The open of the last 8h bar that has closed at `now`: the bar the job scores. */
export function rvSignalBarTime(now: number): number {
  return Math.floor(now / RV_V1.barMs) * RV_V1.barMs - RV_V1.barMs;
}

export interface RvSignalRunOptions {
  /** Pause before the single kline retry. */
  retryDelayMs?: number;
}

interface SymbolError {
  symbol: string;
  error: string;
}

export type RvSignalRunResult =
  | {
      success: true;
      barTime: number;
      /** False when a signal for this bar already existed, and then the stored one is reported. */
      created: boolean;
      skipped: RvFactorResult['skipped'];
      ranked: RvRanked[];
      fetchErrors: SymbolError[];
      syncErrors: SymbolError[];
    }
  | {
      success: false;
      barTime: number;
      code: RvDataError['code'] | 'held_symbol_skipped';
      error: string;
      fetchErrors: SymbolError[];
      syncErrors: SymbolError[];
    };

export type RvSignalDraft = Pick<
  IRvSignal,
  'version' | 'barTime' | 'barCloseTime' | 'rows' | 'ranked' | 'skipped' | 'inputs'
>;

/**
 * Inserts a signal only if none exists for its (version, barTime). An existing
 * signal is never rewritten, because the desk may already have stepped it (D10).
 */
export async function storeRvSignal(doc: RvSignalDraft): Promise<{ created: boolean }> {
  const res = await RvSignal.updateOne(
    { version: doc.version, barTime: doc.barTime },
    { $setOnInsert: doc },
    { upsert: true }
  );
  return { created: res.upsertedCount === 1 };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Symbols either rv-v1 track holds a position in. */
function heldSymbols(book: IRvBook | null): Set<string> {
  const held = new Set<string>();
  if (!book?.tracks) return held;
  for (const track of [book.tracks.taker, book.tracks.maker]) {
    for (const [symbol, p] of Object.entries(track?.positions ?? {})) {
      if (p.qty !== 0) held.add(symbol);
    }
  }
  return held;
}

/**
 * Scores the last closed 8h bar with the rv-v1 engine and stores it.
 *
 * Inputs are perp klines (closed bars only) and the stored funding settlement
 * at or before the bar close, synced from REST first. A symbol whose klines
 * cannot be fetched after one retry gets no bars, so the engine skips it with
 * a reason rather than scoring it on anything else.
 *
 * Fails (success false, for an HTTP 500) on an engine data error, and when a
 * symbol the book holds was skipped: storing that signal would make it
 * permanent, and the desk could never step it (D07). Not storing lets the
 * retry line score the bar once the data is back.
 */
export async function runRvSignal(now: number, opts: RvSignalRunOptions = {}): Promise<RvSignalRunResult> {
  await connectDB();
  const barMs = RV_V1.barMs;
  const barTime = rvSignalBarTime(now);
  const barClose = barTime + barMs;

  const existing = await RvSignal.findOne({ version: RV_V1.version, barTime }).lean<IRvSignal | null>();
  if (existing) {
    return {
      success: true,
      barTime,
      created: false,
      skipped: existing.skipped,
      ranked: existing.ranked,
      fetchErrors: [],
      syncErrors: [],
    };
  }

  const delay = opts.retryDelayMs ?? RETRY_ONCE_DELAY_MS;
  const fetchErrors: SymbolError[] = [];
  const barsBySymbol = new Map<string, RvBar[]>();
  await Promise.all(
    SIGNAL_SYMBOLS.map(async (symbol) => {
      try {
        const klines = await retryOnce(() => fetchPerpKlines(symbol, '8h', RV_SIGNAL_KLINE_LIMIT), delay);
        barsBySymbol.set(
          symbol,
          klines
            .filter((k) => k.openTime + barMs <= now)
            .map((k) => ({ openTime: k.openTime, close: k.close, volume: k.volume, takerBuyVolume: k.takerBuyVolume }))
        );
      } catch (err) {
        fetchErrors.push({ symbol, error: errorText(err) });
        barsBySymbol.set(symbol, []);
      }
    })
  );
  fetchErrors.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const sync = await syncFundingSettlements([...SIGNAL_SYMBOLS], now);
  const syncErrors = sync.filter((r) => r.error).map((r) => ({ symbol: r.symbol, error: r.error as string }));

  const inputs: RvSymbolInput[] = [];
  const lastBarOpenTime: Record<string, number | null> = {};
  const settlement: Record<string, RvSignalSettlementInput | null> = {};
  for (const symbol of SIGNAL_SYMBOLS) {
    const bars = barsBySymbol.get(symbol) ?? [];
    const s = await FundingSettlement.findOne({ symbol, fundingTime: { $lte: barClose } })
      .sort({ fundingTime: -1 })
      .lean<IFundingSettlement | null>();
    inputs.push({
      symbol,
      bars,
      // Archive rows written before markPrice existed lack the field: unknown, not zero
      lastSettlement: s ? { fundingTime: s.fundingTime, rate: s.rate, markPrice: s.markPrice ?? null } : null,
    });
    lastBarOpenTime[symbol] = bars.length > 0 ? Math.max(...bars.map((b) => b.openTime)) : null;
    settlement[symbol] = s ? { fundingTime: s.fundingTime, rate: s.rate } : null;
  }

  let factors: RvFactorResult;
  try {
    factors = rvFactors(inputs, barTime);
  } catch (err) {
    if (!(err instanceof RvDataError)) throw err;
    return { success: false, barTime, code: err.code, error: `${err.code}: ${err.message}`, fetchErrors, syncErrors };
  }

  const held = heldSymbols(await RvBook.findOne({ bookName: RV_BOOK_NAME }).lean<IRvBook | null>());
  const heldSkipped = factors.skipped.filter((s) => held.has(s.symbol));
  if (heldSkipped.length > 0) {
    const list = heldSkipped.map((s) => `${s.symbol} (${s.reason})`).join(', ');
    return {
      success: false,
      barTime,
      code: 'held_symbol_skipped',
      error: `held_symbol_skipped: ${list} is held but could not be scored, so the signal is not stored`,
      fetchErrors,
      syncErrors,
    };
  }

  const ranked = rvComposite(factors.rows, RV_V1.weights);
  const draft: RvSignalDraft = {
    version: RV_V1.version,
    barTime,
    barCloseTime: barClose,
    rows: factors.rows,
    ranked,
    skipped: factors.skipped,
    inputs: { lastBarOpenTime, settlement },
  };
  const { created } = await storeRvSignal(draft);
  // Lost a race with a concurrent run: report the signal that was stored, not this one
  const stored = created
    ? draft
    : await RvSignal.findOne({ version: RV_V1.version, barTime }).lean<IRvSignal | null>();
  if (!stored) throw new Error(`rv signal for ${barTime} was neither inserted nor found`);

  return {
    success: true,
    barTime,
    created,
    skipped: stored.skipped,
    ranked: stored.ranked,
    fetchErrors,
    syncErrors,
  };
}

// ------------------------------------------------- archived pre-rv-v1 computation

/*
 * ARCHIVED: the pre-rv-v1 live computation, kept pure and unchanged because
 * the engine's golden parity test compares against it. Nothing live calls it.
 */
export const RV_PRODUCTION_WEIGHTS: FactorWeights = {
  mom: 0.30,
  idio: 0.25,
  carry: 0.30,
  flow: 0.15,
  news: 0.0,
  vol: 0.0,
};

export const RV_LOOKBACK_BARS = 42; // 14 days of 8-hour bars (42 * 8h = 336h)
export const BAR_MS_8H = 8 * 60 * 60 * 1000;

export interface GeneratedSignalResult {
  timestamp: number;
  barCloseTime: number;
  cadence: string;
  universe: string[];
  snapshots: ICrossSectionalSnapshot[];
  ranks: ICrossSectionalRank[];
  targets: ICrossSectionalTarget[];
  turnover: number;
  rebalanced: boolean;
  netBetaExposure: number;
  grossExposure: number;
}

/**
 * Pure, deterministic factor scoring and portfolio allocation from given candle histories and funding rates.
 */
export function computeCrossSectionalSignalFromCandles(
  candlesBySymbol: Map<string, OHLCV[]>,
  fundingRates: Map<string, number>,
  currentPositions: Map<string, number> = new Map<string, number>()
): GeneratedSignalResult {
  const btcCandles = candlesBySymbol.get('BTCUSDT');
  if (!btcCandles || btcCandles.length < RV_LOOKBACK_BARS + 1) {
    throw new Error(
      `Insufficient BTC candles for 8h cross-sectional evaluation: ${btcCandles?.length ?? 0} provided, minimum ${RV_LOOKBACK_BARS + 1} required`
    );
  }

  // Find the newest common closed candle timestamp across symbols
  const btcSorted = [...btcCandles].sort((a, b) => a.timestamp - b.timestamp);
  const targetBarTimestamp = btcSorted[btcSorted.length - 1].timestamp;

  // Build aligned candle lookup map: symbol -> Array of candles
  const alignedCandles = new Map<string, OHLCV[]>();
  for (const sym of SIGNAL_SYMBOLS) {
    const raw = candlesBySymbol.get(sym);
    if (!raw || raw.length < RV_LOOKBACK_BARS + 1) continue;
    const sorted = [...raw].sort((a, b) => a.timestamp - b.timestamp);
    if (sorted[sorted.length - 1].timestamp === targetBarTimestamp) {
      alignedCandles.set(sym, sorted.slice(-(RV_LOOKBACK_BARS + 1)));
    }
  }

  const activeSymbols = Array.from(alignedCandles.keys());
  if (activeSymbols.length < 5) {
    throw new Error(
      `Insufficient aligned symbols for cross-sectional ranking: ${activeSymbols.length} available, minimum 5 required`
    );
  }

  // BTC returns series over trailing lookback bars
  const btcSeries = alignedCandles.get('BTCUSDT')!;
  const btcCur = btcSeries[btcSeries.length - 1];
  const btcPast = btcSeries[0];
  const btcReturn14d = (btcCur.close - btcPast.close) / btcPast.close;

  const btcRets: number[] = [];
  for (let i = 1; i < btcSeries.length; i++) {
    const prev = btcSeries[i - 1].close;
    if (prev > 0) {
      btcRets.push((btcSeries[i].close - prev) / prev);
    }
  }

  const meanBtc = btcRets.length > 0 ? btcRets.reduce((s, r) => s + r, 0) / btcRets.length : 0;
  const varBtc =
    btcRets.length > 1
      ? btcRets.reduce((s, r) => s + (r - meanBtc) ** 2, 0) / (btcRets.length - 1)
      : 0;

  // Rolling beta per symbol
  const betaMap = new Map<string, number>();
  for (const sym of activeSymbols) {
    if (sym === 'BTCUSDT' || varBtc < 1e-12) {
      betaMap.set(sym, 1.0);
      continue;
    }
    const sSeries = alignedCandles.get(sym)!;
    const symRets: number[] = [];
    for (let i = 1; i < sSeries.length; i++) {
      const prev = sSeries[i - 1].close;
      if (prev > 0) {
        symRets.push((sSeries[i].close - prev) / prev);
      }
    }

    if (symRets.length === btcRets.length && symRets.length > 1) {
      const meanSym = symRets.reduce((s, r) => s + r, 0) / symRets.length;
      const cov =
        symRets.reduce((s, r, idx) => s + (r - meanSym) * (btcRets[idx] - meanBtc), 0) /
        (symRets.length - 1);
      const rawBeta = cov / varBtc;
      betaMap.set(sym, Math.max(0.1, Math.min(3.0, rawBeta)));
    } else {
      betaMap.set(sym, 1.0);
    }
  }

  // Build factor snapshots
  const snapshots: SymbolBarSnapshot[] = [];
  for (const sym of activeSymbols) {
    const sSeries = alignedCandles.get(sym)!;
    const cur = sSeries[sSeries.length - 1];
    const past = sSeries[0];
    const ret14d = (cur.close - past.close) / past.close;

    // Rolling taker buy volume ratio over trailing lookback bars
    let sumTbv = 0;
    let sumVol = 0;
    for (const c of sSeries) {
      sumVol += c.volume;
      sumTbv += c.takerBuyVolume ?? c.volume * 0.5;
    }
    const takerBuyRatio = sumVol > 0 ? sumTbv / sumVol : 0.5;
    const fundingRate = fundingRates.get(sym) ?? 0;

    snapshots.push({
      symbol: sym,
      close: cur.close,
      return7d: ret14d,
      return14d: ret14d,
      fundingRate,
      btcReturn14d,
      betaToBtc: betaMap.get(sym) ?? 1.0,
      takerBuyRatio,
    });
  }

  // Cross-sectional ranking
  const ranks: FactorScores[] = computeCrossSectionalRanks(snapshots, RV_PRODUCTION_WEIGHTS);

  // Portfolio construction (2 legs long, 2 legs short, Buffer 2, Beta-neutral)
  const targetAlloc: TargetAllocation = constructBufferedPortfolio(currentPositions, ranks, {
    legs: 2,
    buffer: 2,
    betas: betaMap,
    weightPerLeg: 0.25,
    autoClampBuffer: true,
  });

  const targets: ICrossSectionalTarget[] = [];
  for (const sym of activeSymbols) {
    const w = targetAlloc.positions.get(sym) ?? 0;
    const side = w > 1e-4 ? 'long' : w < -1e-4 ? 'short' : 'flat';
    targets.push({ symbol: sym, weight: w, side });
  }

  return {
    timestamp: targetBarTimestamp,
    barCloseTime: targetBarTimestamp + BAR_MS_8H,
    cadence: '8h',
    universe: activeSymbols,
    snapshots: snapshots.map((s) => ({
      symbol: s.symbol,
      close: s.close,
      return14d: s.return14d,
      fundingRate: s.fundingRate,
      btcReturn14d: s.btcReturn14d,
      betaToBtc: s.betaToBtc ?? 1.0,
      takerBuyRatio: s.takerBuyRatio ?? 0.5,
    })),
    ranks: ranks.map((r) => ({
      symbol: r.symbol,
      zMom: r.zMom,
      zIdio: r.zIdio,
      zCarry: r.zCarry,
      zFlow: r.zFlow,
      compositeZ: r.compositeZ,
      rank: r.rank,
    })),
    targets,
    turnover: targetAlloc.turnover,
    rebalanced: targetAlloc.rebalanced,
    netBetaExposure: targetAlloc.netBetaExposure ?? 0,
    grossExposure: targetAlloc.grossExposure,
  };
}
