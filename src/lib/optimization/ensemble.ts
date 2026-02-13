import type { IBacktestResultV2 } from '@/lib/models/backtest-result-v2';
import type { SignalWeights } from '@/types/signal';
import { averageWeights } from './weight-generator';

export type PerformanceMetric = 'sharpeRatio' | 'sortino' | 'calmar';

/**
 * Select top N results by metric
 */
export function selectTopPerformers(
  results: IBacktestResultV2[],
  count: number,
  metric: PerformanceMetric = 'sharpeRatio'
): IBacktestResultV2[] {
  // Sort by metric (descending)
  const sorted = [...results].sort((a, b) => {
    const aValue = (a.metrics as Record<string, number>)[metric] ?? -Infinity;
    const bValue = (b.metrics as Record<string, number>)[metric] ?? -Infinity;
    return bValue - aValue;
  });

  return sorted.slice(0, count);
}

/**
 * Extract weights from backtest result config
 */
function extractWeights(result: IBacktestResultV2): SignalWeights {
  const config = result.config as { weights?: SignalWeights };
  if (!config.weights) {
    throw new Error('Backtest result missing weights in config');
  }
  return config.weights;
}

/**
 * Create ensemble weights from top performers
 */
export function createEnsemble(
  results: IBacktestResultV2[],
  topN: number,
  metric: PerformanceMetric = 'sharpeRatio'
): {
  weights: SignalWeights;
  contributors: IBacktestResultV2[];
  avgSharpe: number;
  avgWinRate: number;
  avgSortino: number;
} {
  if (results.length === 0) {
    throw new Error('Cannot create ensemble from empty results');
  }

  const topPerformers = selectTopPerformers(results, topN, metric);

  // Extract weights from each contributor
  const weightSets = topPerformers.map(extractWeights);

  // Average weights
  const ensembleWeights = averageWeights(weightSets);

  // Compute ensemble performance metrics
  const avgSharpe =
    topPerformers.reduce(
      (acc, r) => acc + ((r.metrics as Record<string, number>).sharpeRatio ?? 0),
      0
    ) / topPerformers.length;

  const avgWinRate =
    topPerformers.reduce(
      (acc, r) => acc + ((r.metrics as Record<string, number>).winRate ?? 0),
      0
    ) / topPerformers.length;

  const avgSortino =
    topPerformers.reduce(
      (acc, r) => acc + ((r.metrics as Record<string, number>).sortino ?? 0),
      0
    ) / topPerformers.length;

  return {
    weights: ensembleWeights,
    contributors: topPerformers,
    avgSharpe,
    avgWinRate,
    avgSortino,
  };
}
