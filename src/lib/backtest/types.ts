import type { SignalWeights, SignalTier } from '@/types/signal';

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
  feePercent: number;           // e.g. 0.001 = 0.1%
  weights: SignalWeights;
  startEquity: number;          // starting capital (default 10000)
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
    trend: 0.25,
    momentum: 0.25,
    volume: 0.15,
    volatility: 0.10,
    futures: 0.15,
    sentiment: 0.10,
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
}

export type BacktestProgressCallback = (progress: number, barsProcessed: number, totalBars: number) => void;
