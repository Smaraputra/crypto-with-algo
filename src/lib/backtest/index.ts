export { runBacktest } from './engine';
export { computeMetrics } from './metrics';
export { fixedFractional, kellyCriterion, riskBased } from './position-sizing';
export type {
  BacktestConfig,
  BacktestTrade,
  EquityPoint,
  BacktestMetrics,
  BacktestResult,
  BacktestProgressCallback,
  TradeSide,
  ExitReason,
  PositionSizingMethod,
  PositionSizingConfig,
} from './types';
export { DEFAULT_BACKTEST_CONFIG } from './types';
