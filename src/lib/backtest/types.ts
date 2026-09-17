import type { SignalWeights, SignalTier } from '@/types/signal';
import type { MarketSession } from '@/lib/sessions';
import type { FillKind } from './cost-model';

export type PositionSizingMethod = 'fixed_percent' | 'fixed_fractional' | 'kelly' | 'risk_based';

export interface PositionSizingConfig {
  method: PositionSizingMethod;
  riskPerTrade: number;         // fraction of equity risked (e.g. 0.02 = 2%)
  fractionKelly?: number;       // Kelly scaling factor (default 0.5 = half-Kelly)
}

export interface BacktestConfig {
  entryThreshold: number;       // score above this to enter long (default 30)
  exitThreshold: number;        // score below this to exit long (default -10)
  shortEntryThreshold: number;  // score below this to enter short (default -30)
  shortExitThreshold: number;   // score above this to exit short (default 10)
  stopLossPercent: number;      // e.g. 0.05 = 5%
  takeProfitPercent: number;    // e.g. 0.10 = 10%
  positionSizePercent: number;  // fraction of equity per trade (default 0.10 = 10%)
  positionSizing?: PositionSizingConfig;
  allowShorts: boolean;
  feePercent: number;           // e.g. 0.001 = 0.1%; fallback for maker/taker when unset
  makerFeePercent?: number;     // fraction per side, e.g. 0.0002 = 0.02% (limit fills that rest)
  takerFeePercent?: number;     // fraction per side, e.g. 0.0005 = 0.05% (fills that cross the book)
  slippageBps?: number;         // basis points applied against the trader on taker fills
  fundingEnabled?: boolean;     // accrue perpetual funding on open positions (absent/false = no accrual, legacy path unchanged)
  weights: SignalWeights;
  startEquity: number;          // starting capital (default 10000)
  allowedSessions?: MarketSession[]; // entry filter; undefined/empty = all sessions
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  entryThreshold: 30,
  exitThreshold: -10,
  shortEntryThreshold: -30,
  shortExitThreshold: 10,
  stopLossPercent: 0.05,
  takeProfitPercent: 0.10,
  positionSizePercent: 0.10,
  allowShorts: false,
  feePercent: 0.001,
  weights: {
    trend: 0.225,
    momentum: 0.225,
    volume: 0.135,
    volatility: 0.09,
    futures: 0.135,
    sentiment: 0.09,
    htf: 0.10,
  },
  startEquity: 10000,
};

export type TradeSide = 'long' | 'short';
export type ExitReason = 'signal' | 'stop_loss' | 'take_profit' | 'end_of_data';

export interface BacktestTrade {
  entryBar: number;
  exitBar: number;
  entryTime: number;
  exitTime: number;
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  fees: number;
  exitReason: ExitReason;
  entryScore: number;
  exitScore: number;
  entryTier: SignalTier;
  holdTimeBars: number;
  entrySession?: MarketSession | null; // null when the interval spans sessions
  riskPercent?: number; // stop distance as a percent of entry price (2 means a 2% stop)
  slippageCost: number; // currency lost to slippage on the exit fill, 0 when none applied
  entryFillKind: FillKind;
  exitFillKind: FillKind;
  fundingCost: number; // currency paid to funding while open; positive when the trade paid, 0 when disabled or no data
}

export interface EquityPoint {
  bar: number;
  time: number;
  equity: number;
  drawdown: number;
}

export interface BacktestMetrics {
  totalPnl: number;
  totalPnlPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  avgWin: number;
  avgLoss: number;
  avgWinPercent: number;
  avgLossPercent: number;
  totalFees: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  expectancyPercent: number;
  expectancyR: number | null;
  sessionBreakdown?: SessionBreakdownEntry[]; // present when trades carry sessions
}

export interface SessionBreakdownEntry {
  session: MarketSession;
  trades: number;
  wins: number;
  winRate: number; // 0-1
  totalPnl: number;
  avgPnlPercent: number;
}

export interface SnapshotCoverage {
  barsWithFutures: number;
  barsWithSentiment: number;
  scoredBars: number;
  futuresPercent: number; // 0-100
  sentimentPercent: number; // 0-100
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  config: BacktestConfig;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  startTime: number;
  endTime: number;
  totalBars: number;
  warmupBars: number;
  snapshotCoverage?: SnapshotCoverage; // present when a snapshot series was supplied
}

export type BacktestProgressCallback = (progress: number, barsProcessed: number, totalBars: number) => void;
