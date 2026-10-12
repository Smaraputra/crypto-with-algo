import crypto from 'crypto';
import { connectDB } from '@/lib/mongodb';
import {
  CrossSectionalBook,
  type ICrossSectionalPosition,
} from '@/lib/models/cross-sectional-book';
import { CrossSectionalTrade } from '@/lib/models/cross-sectional-trade';
import {
  CrossSectionalSignal,
  type ICrossSectionalSignal,
} from '@/lib/models/cross-sectional-signal';

export const MAKER_FEE_RATE = 0.00018; // 1.8 bps
export const TAKER_FEE_RATE = 0.0007; // 5 bps fee + 2 bps slippage = 7 bps
export const DESK_LEASE_MS = 10 * 60 * 1000; // 10 minutes

export interface CrossSectionalBookState {
  bookName: string;
  startEquity: number;
  equityMaker: number;
  equityTaker: number;
  lastProcessedBarTime: number | null;
  positions: ICrossSectionalPosition[];
  totalTurnover: number;
  totalFundingCollected: number;
  peakLeverage: number;
}

export interface ClosedTradeRecord {
  bookName: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  barsHeld: number;
  weight: number;
  pnlGross: number;
  pnlPercentGross: number;
  pnlNetMaker: number;
  pnlPercentNetMaker: number;
  pnlNetTaker: number;
  pnlPercentNetTaker: number;
  fundingCollected: number;
  exitReason: string;
}

export interface StepReport {
  updatedBook: CrossSectionalBookState;
  closedTrades: ClosedTradeRecord[];
}

/**
 * Pure state step function: applies an 8h cross-sectional signal to current book state.
 */
export function stepCrossSectionalBookState(
  state: CrossSectionalBookState,
  signal: ICrossSectionalSignal
): StepReport {
  let equityMaker = state.equityMaker;
  let equityTaker = state.equityTaker;
  let totalFunding = state.totalFundingCollected;
  const closedTrades: ClosedTradeRecord[] = [];
  const snapshotMap = new Map(signal.snapshots.map((s) => [s.symbol, s]));
  const targetMap = new Map(signal.targets.map((t) => [t.symbol, t.weight]));

  // 1. Accrue funding settlement for existing open positions across the bar that just closed
  for (const pos of state.positions) {
    const snap = snapshotMap.get(pos.symbol);
    if (!snap) continue;

    // Funding cash flow: longs pay positive rate (receive negative); shorts receive positive (pay negative)
    const rate = snap.fundingRate;
    const makerCashFlow = pos.side === 'long' ? -pos.notionalMaker * rate : pos.notionalMaker * rate;
    const takerCashFlow = pos.side === 'long' ? -pos.notionalTaker * rate : pos.notionalTaker * rate;

    equityMaker += makerCashFlow;
    equityTaker += takerCashFlow;
    totalFunding += (makerCashFlow + takerCashFlow) / 2;
  }

  // 2. Identify positions to close or retain
  const remainingPositions: ICrossSectionalPosition[] = [];

  for (const pos of state.positions) {
    const targetWeight = targetMap.get(pos.symbol) ?? 0;
    const snap = snapshotMap.get(pos.symbol);
    const exitPrice = snap ? snap.close : pos.entryPrice;

    // Check if direction flipped or target weight dropped to 0 (fell out of buffer)
    const isClosed =
      (pos.side === 'long' && targetWeight <= 1e-4) ||
      (pos.side === 'short' && targetWeight >= -1e-4);

    if (isClosed) {
      // Realize PnL
      const priceReturn =
        pos.side === 'long'
          ? (exitPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - exitPrice) / pos.entryPrice;

      const pnlGrossMaker = pos.notionalMaker * priceReturn;
      const pnlGrossTaker = pos.notionalTaker * priceReturn;

      const exitFeeMaker = pos.notionalMaker * MAKER_FEE_RATE;
      const exitFeeTaker = pos.notionalTaker * TAKER_FEE_RATE;

      const pnlNetMaker = pnlGrossMaker - exitFeeMaker;
      const pnlNetTaker = pnlGrossTaker - exitFeeTaker;

      equityMaker += pnlNetMaker;
      equityTaker += pnlNetTaker;

      closedTrades.push({
        bookName: state.bookName,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        entryTime: pos.entryTime,
        exitTime: signal.barCloseTime,
        barsHeld: pos.barsHeld + 1,
        weight: pos.weight,
        pnlGross: (pnlGrossMaker + pnlGrossTaker) / 2,
        pnlPercentGross: priceReturn * 100,
        pnlNetMaker,
        pnlPercentNetMaker: (pnlNetMaker / pos.notionalMaker) * 100,
        pnlNetTaker,
        pnlPercentNetTaker: (pnlNetTaker / pos.notionalTaker) * 100,
        fundingCollected: 0,
        exitReason: 'rank_buffer_exit',
      });
    } else {
      // Retained position: rebalance notional to new weight if changed
      const newWeight = Math.abs(targetWeight);
      const newNotionalMaker = equityMaker * newWeight;
      const newNotionalTaker = equityTaker * newWeight;

      // Turnover fee on weight adjustment delta
      const deltaMaker = Math.abs(newNotionalMaker - pos.notionalMaker);
      const deltaTaker = Math.abs(newNotionalTaker - pos.notionalTaker);

      equityMaker -= deltaMaker * MAKER_FEE_RATE;
      equityTaker -= deltaTaker * TAKER_FEE_RATE;

      remainingPositions.push({
        symbol: pos.symbol,
        side: pos.side,
        weight: newWeight,
        entryPrice: pos.entryPrice,
        entryTime: pos.entryTime,
        notionalMaker: newNotionalMaker,
        notionalTaker: newNotionalTaker,
        barsHeld: pos.barsHeld + 1,
      });
    }
  }

  // 3. Open new positions
  const currentSymbols = new Set(remainingPositions.map((p) => p.symbol));

  for (const [sym, weight] of targetMap.entries()) {
    if (Math.abs(weight) <= 1e-4) continue;
    if (currentSymbols.has(sym)) continue;

    const snap = snapshotMap.get(sym);
    if (!snap) continue;

    const side: 'long' | 'short' = weight > 0 ? 'long' : 'short';
    const absWeight = Math.abs(weight);
    const notionalMaker = equityMaker * absWeight;
    const notionalTaker = equityTaker * absWeight;

    // Entry fee
    equityMaker -= notionalMaker * MAKER_FEE_RATE;
    equityTaker -= notionalTaker * TAKER_FEE_RATE;

    remainingPositions.push({
      symbol: sym,
      side,
      weight: absWeight,
      entryPrice: snap.close,
      entryTime: signal.barCloseTime,
      notionalMaker,
      notionalTaker,
      barsHeld: 0,
    });
  }

  const updatedBook: CrossSectionalBookState = {
    bookName: state.bookName,
    startEquity: state.startEquity,
    equityMaker: Math.max(0, equityMaker),
    equityTaker: Math.max(0, equityTaker),
    lastProcessedBarTime: signal.timestamp,
    positions: remainingPositions,
    totalTurnover: state.totalTurnover + signal.turnover,
    totalFundingCollected: totalFunding,
    peakLeverage: Math.max(state.peakLeverage, signal.grossExposure),
  };

  return { updatedBook, closedTrades };
}

/**
 * Runs the paper desk execution cycle for the 8h cross-sectional portfolio.
 */
export async function runCrossSectionalPaperDesk(
  bookName = 'rv-8h-buffer2'
): Promise<{
  stepped: number;
  closedTradesCount: number;
  openPositionsCount: number;
  equityMaker: number;
  equityTaker: number;
  leasedOut?: boolean;
}> {
  await connectDB();

  const now = new Date();
  const leaseOwner = crypto.randomUUID();

  // Acquire or create book with exclusive lease
  let book = await CrossSectionalBook.findOne({ bookName });

  if (!book) {
    book = await CrossSectionalBook.create({
      bookName,
      startEquity: 10000,
      equityMaker: 10000,
      equityTaker: 10000,
      lastProcessedBarTime: null,
      positions: [],
      totalTurnover: 0,
      totalFundingCollected: 0,
      peakLeverage: 0,
      leaseUntil: new Date(now.getTime() + DESK_LEASE_MS),
      leaseOwner,
    });
  } else {
    // Check if lease is active
    if (book.leaseUntil && book.leaseUntil > now && book.leaseOwner !== leaseOwner) {
      return {
        stepped: 0,
        closedTradesCount: 0,
        openPositionsCount: book.positions.length,
        equityMaker: book.equityMaker,
        equityTaker: book.equityTaker,
        leasedOut: true,
      };
    }

    // Acquire lease
    book.leaseUntil = new Date(now.getTime() + DESK_LEASE_MS);
    book.leaseOwner = leaseOwner;
    await book.save();
  }

  try {
    // Find unstepped signals sorted by timestamp ascending
    const query: Record<string, unknown> = {};
    if (book.lastProcessedBarTime !== null) {
      query.timestamp = { $gt: book.lastProcessedBarTime };
    }

    const unsteppedSignals = await CrossSectionalSignal.find(query)
      .sort({ timestamp: 1 })
      .lean();

    let totalClosed = 0;
    let bookState: CrossSectionalBookState = {
      bookName: book.bookName,
      startEquity: book.startEquity,
      equityMaker: book.equityMaker,
      equityTaker: book.equityTaker,
      lastProcessedBarTime: book.lastProcessedBarTime,
      positions: book.positions,
      totalTurnover: book.totalTurnover,
      totalFundingCollected: book.totalFundingCollected,
      peakLeverage: book.peakLeverage,
    };

    for (const sig of unsteppedSignals) {
      const stepResult = stepCrossSectionalBookState(bookState, sig as ICrossSectionalSignal);
      bookState = stepResult.updatedBook;

      if (stepResult.closedTrades.length > 0) {
        await CrossSectionalTrade.insertMany(stepResult.closedTrades);
        totalClosed += stepResult.closedTrades.length;
      }
    }

    // Save updated book state and clear lease
    book.equityMaker = bookState.equityMaker;
    book.equityTaker = bookState.equityTaker;
    book.lastProcessedBarTime = bookState.lastProcessedBarTime;
    book.positions = bookState.positions;
    book.totalTurnover = bookState.totalTurnover;
    book.totalFundingCollected = bookState.totalFundingCollected;
    book.peakLeverage = bookState.peakLeverage;
    book.leaseUntil = null;
    book.leaseOwner = null;
    await book.save();

    return {
      stepped: unsteppedSignals.length,
      closedTradesCount: totalClosed,
      openPositionsCount: book.positions.length,
      equityMaker: book.equityMaker,
      equityTaker: book.equityTaker,
    };
  } catch (error) {
    // Ensure lease is cleared on error
    await CrossSectionalBook.updateOne(
      { bookName },
      { $set: { leaseUntil: null, leaseOwner: null } }
    );
    throw error;
  }
}
