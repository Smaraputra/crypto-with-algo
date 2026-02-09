export { runBacktest } from './engine';
export { computeMetrics } from './metrics';
export type {
  BacktestConfig,
  BacktestTrade,
  EquityPoint,
  BacktestMetrics,
  BacktestResult,
  BacktestProgressCallback,
  TradeSide,
  ExitReason,
} from './types';
export { DEFAULT_BACKTEST_CONFIG } from './types';
