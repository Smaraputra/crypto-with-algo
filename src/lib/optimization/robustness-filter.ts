import type { IBacktestResultV2 } from '@/lib/models/backtest-result-v2';
import type { RobustnessConfig } from '@/types/optimization';
import { DEFAULT_ROBUSTNESS } from '@/types/optimization';

/**
 * Check if backtest result passes robustness filters
 */
export function isRobust(
  result: IBacktestResultV2,
  config: RobustnessConfig = DEFAULT_ROBUSTNESS
): boolean {
  const metrics = result.metrics as {
    sharpeRatio?: number;
    winRate?: number;
    maxDrawdownPercent?: number;
    expectancyPercent?: number;
  };

  const { totalTrades } = result.tradeSummary;

  // Check minimum trades for statistical significance
  if (totalTrades < config.minTrades) {
    return false;
  }

  // Check Sharpe ratio (provisional threshold; see RobustnessConfig)
  const sharpe = metrics.sharpeRatio ?? -Infinity;
  if (sharpe < config.minSharpe) {
    return false;
  }

  // Check win rate
  const winRate = metrics.winRate ?? 0;
  if (winRate < config.minWinRate) {
    return false;
  }

  // Check max drawdown: metrics.maxDrawdown is an absolute currency amount,
  // so compare maxDrawdownPercent (0-100) as a fraction against the config
  const ddFraction = (metrics.maxDrawdownPercent ?? Infinity) / 100;
  if (ddFraction > config.maxDrawdown) {
    return false;
  }

  // Check net expectancy: at the default floor of 0 this requires strictly
  // positive expectancy, since minSharpe alone no longer isolates a
  // breakeven-or-worse candidate after the annualization fix
  const expectancyPercent = metrics.expectancyPercent ?? -Infinity;
  if (expectancyPercent <= config.minExpectancyPercent) {
    return false;
  }

  return true;
}

/**
 * Filter array of results, return only robust ones
 */
export function filterRobustResults(
  results: IBacktestResultV2[],
  config: RobustnessConfig = DEFAULT_ROBUSTNESS
): IBacktestResultV2[] {
  return results.filter((r) => isRobust(r, config));
}

/**
 * Get robustness score (0-1) for ranking results
 * Higher score = more robust
 */
export function getRobustnessScore(
  result: IBacktestResultV2,
  config: RobustnessConfig = DEFAULT_ROBUSTNESS
): number {
  const metrics = result.metrics as {
    sharpeRatio?: number;
    winRate?: number;
    maxDrawdownPercent?: number;
  };

  const { totalTrades } = result.tradeSummary;

  // If not robust, score = 0
  if (!isRobust(result, config)) {
    return 0;
  }

  // Compute normalized scores
  const sharpeScore = Math.min((metrics.sharpeRatio ?? 0) / 2.0, 1.0); // Normalize to [0, 1], 2.0 = excellent
  const winRateScore = (metrics.winRate ?? 0) / 1.0; // Already [0, 1]
  const ddScore = 1 - Math.min((metrics.maxDrawdownPercent ?? 100) / 100 / config.maxDrawdown, 1.0); // Lower DD = better
  const tradeScore = Math.min(totalTrades / 50, 1.0); // Normalize to 50 trades = full score

  // Weighted average
  return sharpeScore * 0.4 + winRateScore * 0.3 + ddScore * 0.2 + tradeScore * 0.1;
}
