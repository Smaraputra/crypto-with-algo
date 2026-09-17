import type { BacktestTrade, EquityPoint, BacktestMetrics, SessionBreakdownEntry } from './types';
import { MARKET_SESSIONS } from '@/lib/sessions';
import { barsPerYear } from '@/lib/intervals';

export function computeMetrics(
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  startEquity: number,
  interval: string
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

  const bars = barsPerYear(interval);

  // Sharpe ratio (annualized from the interval's bars per year)
  const sharpeRatio = computeSharpe(equityCurve, startEquity, bars);

  // Sortino ratio
  const sortinoRatio = computeSortino(equityCurve, startEquity, bars);

  // Expectancy per trade, the objective the study is judged on
  const { expectancyPercent, expectancyR } = computeExpectancy(trades);

  // Calmar ratio
  const calmarRatio = maxDrawdownPercent > 0
    ? totalPnlPercent / maxDrawdownPercent
    : 0;

  // Consecutive wins/losses
  const { maxConsecutiveWins, maxConsecutiveLosses } = computeStreaks(trades);

  // Per-session breakdown (only when trades carry session tags)
  const sessionBreakdown = computeSessionBreakdown(trades);

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
    expectancyPercent,
    expectancyR,
    ...(sessionBreakdown ? { sessionBreakdown } : {}),
  };
}

export function computeExpectancy(trades: BacktestTrade[]): {
  expectancyPercent: number;
  expectancyR: number | null;
} {
  if (trades.length === 0) {
    return { expectancyPercent: 0, expectancyR: null };
  }

  const expectancyPercent =
    trades.reduce((sum, t) => sum + t.pnlPercent, 0) / trades.length;

  const rMultiples = trades
    .filter((t) => typeof t.riskPercent === 'number' && Number.isFinite(t.riskPercent) && t.riskPercent > 0)
    .map((t) => t.pnlPercent / (t.riskPercent as number));

  const expectancyR = rMultiples.length > 0
    ? rMultiples.reduce((sum, r) => sum + r, 0) / rMultiples.length
    : null;

  return { expectancyPercent, expectancyR };
}

function computeSessionBreakdown(trades: BacktestTrade[]): SessionBreakdownEntry[] | null {
  const tagged = trades.filter((t) => t.entrySession != null);
  if (tagged.length === 0) return null;

  const breakdown: SessionBreakdownEntry[] = [];
  for (const session of MARKET_SESSIONS) {
    const sessionTrades = tagged.filter((t) => t.entrySession === session);
    if (sessionTrades.length === 0) continue;

    const wins = sessionTrades.filter((t) => t.pnl > 0).length;
    breakdown.push({
      session,
      trades: sessionTrades.length,
      wins,
      winRate: wins / sessionTrades.length,
      totalPnl: sessionTrades.reduce((sum, t) => sum + t.pnl, 0),
      avgPnlPercent:
        sessionTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / sessionTrades.length,
    });
  }

  return breakdown;
}

function computeSharpe(equityCurve: EquityPoint[], startEquity: number, annualizationFactor: number): number {
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

  return (mean / stdDev) * Math.sqrt(annualizationFactor);
}

function computeSortino(equityCurve: EquityPoint[], startEquity: number, annualizationFactor: number): number {
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

  return (mean / downsideDev) * Math.sqrt(annualizationFactor);
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
