import type { SignalWeights } from './signal';

export interface RobustnessConfig {
  minSharpe: number; // 0.5
  minWinRate: number; // 0.40 (40%)
  maxDrawdown: number; // 0.30 (30%)
  minTrades: number; // 10 (statistical significance)
}

export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  bestWeights: SignalWeights;
  testSharpe: number;
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
  stepSizeBars: 300,
  candidatesPerWindow: 50,
  constraintPercent: 0.2, // ±20%
} as const;
