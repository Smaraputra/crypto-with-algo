import type { RiskMetrics } from '@/types/analytics';

const MIN_DRAWDOWN_POINTS = 7;
const MIN_RATIO_POINTS = 30;
const RISK_FREE_RATE = 0.05;
const DAYS_PER_YEAR = 365;

interface DataPoint {
  date: string;
  totalValue: number;
}

export function computeRiskMetrics(
  snapshots: DataPoint[]
): RiskMetrics | null {
  if (snapshots.length < 2) return null;

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const dailyReturns: { date: string; ret: number }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].totalValue;
    if (prev === 0) continue;
    dailyReturns.push({
      date: sorted[i].date,
      ret: (sorted[i].totalValue - prev) / prev,
    });
  }

  if (dailyReturns.length === 0) return null;

  const returns = dailyReturns.map((d) => d.ret);
  const n = returns.length;

  const firstValue = sorted[0].totalValue;
  const lastValue = sorted[sorted.length - 1].totalValue;
  const totalReturn = firstValue > 0 ? (lastValue - firstValue) / firstValue : null;

  const daySpan =
    (new Date(sorted[sorted.length - 1].date).getTime() -
      new Date(sorted[0].date).getTime()) /
    (1000 * 60 * 60 * 24);
  const annualizedReturn =
    totalReturn !== null && daySpan > 0
      ? Math.pow(1 + totalReturn, DAYS_PER_YEAR / daySpan) - 1
      : null;

  // Best/worst day
  let bestIdx = 0;
  let worstIdx = 0;
  for (let i = 1; i < n; i++) {
    if (returns[i] > returns[bestIdx]) bestIdx = i;
    if (returns[i] < returns[worstIdx]) worstIdx = i;
  }
  const bestDay = { date: dailyReturns[bestIdx].date, return: returns[bestIdx] };
  const worstDay = { date: dailyReturns[worstIdx].date, return: returns[worstIdx] };

  // Volatility
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const dailyVol = Math.sqrt(variance);
  const annualizedVolatility = dailyVol * Math.sqrt(DAYS_PER_YEAR);

  // Max drawdown (requires >= 7 data points)
  let maxDrawdown: number | null = null;
  let maxDrawdownDate: string | null = null;
  if (sorted.length >= MIN_DRAWDOWN_POINTS) {
    let peak = sorted[0].totalValue;
    let maxDd = 0;
    let ddDate = sorted[0].date;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].totalValue > peak) {
        peak = sorted[i].totalValue;
      }
      const dd = peak > 0 ? (sorted[i].totalValue - peak) / peak : 0;
      if (dd < maxDd) {
        maxDd = dd;
        ddDate = sorted[i].date;
      }
    }
    maxDrawdown = maxDd;
    maxDrawdownDate = ddDate;
  }

  // Sharpe ratio (requires >= 30 data points)
  let sharpeRatio: number | null = null;
  let sortinoRatio: number | null = null;
  if (n >= MIN_RATIO_POINTS && annualizedVolatility > 0 && annualizedReturn !== null) {
    sharpeRatio = (annualizedReturn - RISK_FREE_RATE) / annualizedVolatility;

    // Sortino: downside deviation
    const downsideReturns = returns.filter((r) => r < 0);
    if (downsideReturns.length > 0) {
      const downsideVariance =
        downsideReturns.reduce((s, r) => s + r ** 2, 0) / downsideReturns.length;
      const downsideDeviation = Math.sqrt(downsideVariance) * Math.sqrt(DAYS_PER_YEAR);
      if (downsideDeviation > 0) {
        sortinoRatio = (annualizedReturn - RISK_FREE_RATE) / downsideDeviation;
      }
    }
  }

  return {
    annualizedVolatility,
    maxDrawdown,
    maxDrawdownDate,
    sharpeRatio,
    sortinoRatio,
    bestDay,
    worstDay,
    annualizedReturn,
    totalReturn,
    dataPoints: sorted.length,
  };
}
