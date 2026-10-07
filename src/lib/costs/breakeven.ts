/**
 * The win rate a trade needs just to pay its costs.
 *
 * A trade that wins `targetPercent` gross (paying `winCostPercent`) and
 * loses `stopPercent` gross (paying `lossCostPercent`) breaks even when
 *
 *   p x (T - C_win) = (1 - p) x (S + C_loss)
 *   p* = (S + C_loss) / (S + T + C_loss - C_win)
 *
 * With no costs a 1:2 bracket (T = 2S) needs 1/3 winners. With symmetric
 * moves of M each way and the same cost C on both outcomes it reduces to
 * 0.5 + C / (2M): the directional accuracy needed to break even. M must be
 * the MEAN move, because expected gross is (2p - 1) x E|r|; the median would
 * overstate the bar on fat-tailed returns.
 *
 * When a win does not cover its own cost (T <= C_win), no win rate breaks
 * even and the result is `impossible`, never a percentage of 100 or more.
 */

export type Breakeven = { kind: 'possible'; winRate: number } | { kind: 'impossible' };

export interface BracketInput {
  stopPercent: number;
  targetPercent: number;
  lossCostPercent: number;
  winCostPercent: number;
}

export function bracketBreakeven(input: BracketInput): Breakeven {
  const { stopPercent: s, targetPercent: t, lossCostPercent: cLoss, winCostPercent: cWin } = input;
  if (!(s > 0) || !(t > 0)) throw new Error('Stop and target distances must be positive');
  const netWin = t - cWin;
  if (!(netWin > 0)) return { kind: 'impossible' };
  return { kind: 'possible', winRate: (s + cLoss) / (s + cLoss + netWin) };
}

/** Breakeven directional accuracy when wins and losses are each about `meanMovePercent`. */
export function symmetricBreakeven(costPercent: number, meanMovePercent: number): Breakeven {
  return bracketBreakeven({
    stopPercent: meanMovePercent,
    targetPercent: meanMovePercent,
    lossCostPercent: costPercent,
    winCostPercent: costPercent,
  });
}

export const DAYS_PER_MONTH = 365 / 12;

export interface CostBurn {
  perMonthUsdt: number;
  /** Percent of account equity spent on costs per month; null without an equity. */
  percentOfEquity: number | null;
}

/** What trading costs add up to over a month at a steady trade rate. */
export function monthlyCostBurn(tradesPerDay: number, roundTripUsdt: number, equity: number | null): CostBurn {
  const perMonthUsdt = tradesPerDay * roundTripUsdt * DAYS_PER_MONTH;
  return {
    perMonthUsdt,
    percentOfEquity: equity !== null && equity > 0 ? (perMonthUsdt / equity) * 100 : null,
  };
}
