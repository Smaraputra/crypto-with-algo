import type { SignalWeights } from './signal';

export interface RobustnessConfig {
  minSharpe: number; // 0.5
  minWinRate: number; // 0.40 (40%)
  maxDrawdown: number; // 0.30 = 30% of peak equity, compared against metrics.maxDrawdownPercent / 100
  minTrades: number; // 10 (statistical significance)
}

export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  bestWeights: SignalWeights;
  testSharpe: number;
  testResultId?: string; // BacktestResultV2 id of the out-of-sample test run
}

export interface OptimizationProgress {
  currentWindow: number;
  totalWindows: number;
  candidatesTested: number;
  validResults: number;
}

export type OptimizationStatus = 'pending' | 'running' | 'completed' | 'failed';

export const DEFAULT_ROBUSTNESS: RobustnessConfig = {
  minSharpe: 0.5,
  minWinRate: 0.4,
  maxDrawdown: 0.3,
  minTrades: 10,
};

export const DEFAULT_OPTIMIZATION_CONFIG = {
  minTrainingBars: 300,
  testWindowBars: 100,
  // Fallback step for callers that optimize a single known series. The monthly
  // orchestrator derives its own step from data length via deriveStepSize,
  // because a fixed step cannot suit both 5m and 1d series.
  stepSizeBars: 300,
  // Walk-forward windows the orchestrator aims for, per style. Each window
  // costs candidatesPerWindow backtests over an expanding training set, so this
  // is the main lever on total optimization cost.
  targetWindows: 6,
  candidatesPerWindow: 50,
  constraintPercent: 0.2, // ±20%
} as const;

/**
 * Whether the monthly cron may activate the templates it produces without
 * human review. Defaults to false: with no templates in the database, the
 * first run would otherwise promote unreviewed output straight to live
 * signals. Flip OPTIMIZATION_AUTO_ACTIVATE=true only once a month of output
 * has been inspected through /admin/optimization.
 */
export function isAutoActivateEnabled(): boolean {
  return process.env.OPTIMIZATION_AUTO_ACTIVATE === 'true';
}
