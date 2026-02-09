/**
 * Fixed fractional: risk a fixed fraction of equity per trade.
 * Returns the position quantity.
 */
export function fixedFractional(
  equity: number,
  riskPerTrade: number,
  entryPrice: number,
  stopLossPrice: number
): number {
  if (entryPrice <= 0 || stopLossPrice <= 0) return 0;
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
  if (riskPerUnit === 0) return 0;
  const dollarRisk = equity * riskPerTrade;
  return dollarRisk / riskPerUnit;
}

/**
 * Kelly criterion: optimal position size based on win rate and payoff ratio.
 * fractionKelly allows scaling (e.g. 0.5 for half-Kelly).
 * Returns the position quantity.
 */
export function kellyCriterion(
  equity: number,
  winRate: number,
  avgWin: number,
  avgLoss: number,
  entryPrice: number,
  fractionKelly: number = 0.5
): number {
  if (entryPrice <= 0 || avgLoss === 0) return 0;
  const b = avgWin / Math.abs(avgLoss); // payoff ratio
  const kellyFraction = (winRate * b - (1 - winRate)) / b;
  // Clamp kelly fraction to [0, 1]
  const clampedFraction = Math.max(0, Math.min(1, kellyFraction * fractionKelly));
  const dollarAmount = equity * clampedFraction;
  return dollarAmount / entryPrice;
}

/**
 * Risk-based sizing: same as fixed fractional but uses explicit risk per trade.
 * Returns the position quantity.
 */
export function riskBased(
  equity: number,
  riskPerTrade: number,
  entryPrice: number,
  stopLossPrice: number
): number {
  return fixedFractional(equity, riskPerTrade, entryPrice, stopLossPrice);
}
