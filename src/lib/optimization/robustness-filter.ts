import type { IBacktestResultV2 } from '@/lib/models/backtest-result-v2';
import type { RobustnessConfig } from '@/types/optimization';
import { DEFAULT_ROBUSTNESS } from '@/types/optimization';

/**
 * Win rate, payoff and profit factor are reported and never gated or ranked
 * on (2026-09-17 ruling). This gate is trades, Sharpe, drawdown and positive
 * expectancy only.
 */
export function isRobust(
  result: IBacktestResultV2,
  config: RobustnessConfig = DEFAULT_ROBUSTNESS
): boolean {
  const metrics = result.metrics as {
    sharpeRatio?: number;
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
