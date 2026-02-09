import type { BacktestTrade, EquityPoint, BacktestMetrics } from './types';

export function computeMetrics(
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  startEquity: number
): BacktestMetrics {
  const finalEquity = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1].equity
    : startEquity;

  const totalPnl = finalEquity - startEquity;
  const totalPnlPercent = startEquity > 0 ? (totalPnl / startEquity) * 100 : 0;
  const totalTrades = trades.length;

  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);
  const winningTrades = winners.length;
  const losingTrades = losers.length;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

  const grossProfit = winners.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const avgWin = winningTrades > 0 ? grossProfit / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? grossLoss / losingTrades : 0;
  const avgWinPercent = winningTrades > 0
    ? winners.reduce((sum, t) => sum + t.pnlPercent, 0) / winningTrades
    : 0;
  const avgLossPercent = losingTrades > 0
    ? Math.abs(losers.reduce((sum, t) => sum + t.pnlPercent, 0)) / losingTrades
    : 0;

  const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);

  // Max drawdown
  let peakEquity = startEquity;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peakEquity) {
      peakEquity = point.equity;
    }
    const dd = peakEquity - point.equity;
    const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPercent = ddPct;
    }
  }

  // Sharpe ratio (annualized, assuming daily returns)
  const sharpeRatio = computeSharpe(equityCurve, startEquity);

  // Sortino ratio
  const sortinoRatio = computeSortino(equityCurve, startEquity);

  // Calmar ratio
  const calmarRatio = maxDrawdownPercent > 0
    ? totalPnlPercent / maxDrawdownPercent
    : 0;

  // Consecutive wins/losses
  const { maxConsecutiveWins, maxConsecutiveLosses } = computeStreaks(trades);

  return {
    totalPnl,
    totalPnlPercent,
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    profitFactor,
    maxDrawdown,
    maxDrawdownPercent,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    avgWin,
    avgLoss,
    avgWinPercent,
    avgLossPercent,
    totalFees,
    maxConsecutiveWins,
    maxConsecutiveLosses,
  };
}

function computeSharpe(equityCurve: EquityPoint[], startEquity: number): number {
  if (equityCurve.length < 2) return 0;

  const returns: number[] = [];
  let prev = startEquity;
  for (const point of equityCurve) {
    if (prev > 0) {
      returns.push((point.equity - prev) / prev);
    }
    prev = point.equity;
  }

  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize: assume ~252 trading periods per year
  return (mean / stdDev) * Math.sqrt(252);
}

function computeSortino(equityCurve: EquityPoint[], startEquity: number): number {
  if (equityCurve.length < 2) return 0;

  const returns: number[] = [];
  let prev = startEquity;
  for (const point of equityCurve) {
    if (prev > 0) {
      returns.push((point.equity - prev) / prev);
    }
    prev = point.equity;
  }

  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const downsideReturns = returns.filter((r) => r < 0);

  if (downsideReturns.length === 0) return mean > 0 ? Infinity : 0;

  const downsideVariance =
    downsideReturns.reduce((s, r) => s + r ** 2, 0) / downsideReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);

  if (downsideDev === 0) return 0;

  return (mean / downsideDev) * Math.sqrt(252);
}

function computeStreaks(trades: BacktestTrade[]): {
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
} {
  let maxWins = 0;
  let maxLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;

  for (const trade of trades) {
    if (trade.pnl > 0) {
      currentWins++;
      currentLosses = 0;
      if (currentWins > maxWins) maxWins = currentWins;
    } else {
      currentLosses++;
      currentWins = 0;
      if (currentLosses > maxLosses) maxLosses = currentLosses;
    }
  }

  return { maxConsecutiveWins: maxWins, maxConsecutiveLosses: maxLosses };
}
