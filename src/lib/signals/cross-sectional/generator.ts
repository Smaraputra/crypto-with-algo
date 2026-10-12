import type { OHLCV } from '@/types/market';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { fetchKlines } from '@/lib/binance';
import { fetchFundingRate } from '@/lib/binance-futures';
import { connectDB } from '@/lib/mongodb';
import {
  CrossSectionalSignal,
  type ICrossSectionalSignal,
  type ICrossSectionalSnapshot,
  type ICrossSectionalRank,
  type ICrossSectionalTarget,
} from '@/lib/models/cross-sectional-signal';
import {
  computeCrossSectionalRanks,
  type FactorScores,
  type FactorWeights,
  type SymbolBarSnapshot,
} from './factors';
import { constructBufferedPortfolio, type TargetAllocation } from './portfolio';

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

/**
 * Live pipeline: fetches live 8h candles and funding rates, computes factor signal,
 * and upserts into the CrossSectionalSignal MongoDB collection.
 */
export async function generateAndSaveCrossSectionalSignal(): Promise<ICrossSectionalSignal> {
  await connectDB();

  // 1. Fetch latest 8h candles and funding rates for all SIGNAL_SYMBOLS
  const candlesBySymbol = new Map<string, OHLCV[]>();
  const fundingRates = new Map<string, number>();

  await Promise.all(
    SIGNAL_SYMBOLS.map(async (sym) => {
      try {
        // Fetch 45 8h candles to have full 42-bar lookback after dropping in-progress candle
        const raw = await fetchKlines(sym, '8h', 45);
        const now = Date.now();
        // Keep only closed 8h bars
        const closed = raw.filter((c) => c.timestamp + BAR_MS_8H <= now);
        candlesBySymbol.set(sym, closed);
      } catch (err) {
        console.error(`Failed to fetch 8h klines for ${sym}:`, err);
      }

      try {
        const rates = await fetchFundingRate(sym, 1);
        if (rates.length > 0) {
          fundingRates.set(sym, rates[0].fundingRate);
        }
      } catch (err) {
        console.error(`Failed to fetch funding rate for ${sym}:`, err);
      }
    })
  );

  // 2. Fetch the most recent CrossSectionalSignal to carry forward current positions
  const lastSignal = await CrossSectionalSignal.findOne()
    .sort({ timestamp: -1 })
    .lean();

  const currentPositions = new Map<string, number>();
  if (lastSignal && Array.isArray(lastSignal.targets)) {
    for (const t of lastSignal.targets) {
      if (Math.abs(t.weight) > 1e-4) {
        currentPositions.set(t.symbol, t.weight);
      }
    }
  }

  // 3. Compute new factor signal and target allocation
  const computed = computeCrossSectionalSignalFromCandles(
    candlesBySymbol,
    fundingRates,
    currentPositions
  );

  // 4. Upsert document by bar timestamp
  const doc = await CrossSectionalSignal.findOneAndUpdate(
    { timestamp: computed.timestamp },
    { $set: computed },
    { upsert: true, new: true }
  );

  return doc;
}
