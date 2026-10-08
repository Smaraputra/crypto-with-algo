/**
 * Leverage arithmetic for a perpetual position. Fees and any edge are both
 * per unit of notional, and leverage multiplies the notional, not the
 * round-trip rate: a 0.12% round trip is 0.12% of notional at any leverage,
 * and 0.12% x L of the margin. Moved here from scripts/research/frontier.ts
 * (which re-exports it, so its recorded output is unchanged) so the Cost
 * Check page can use it.
 */

export interface LeverageRow {
  leverage: number;
  notionalUsdt: number;
  costUsdt: number;
  costPercentOfAccount: number;
}

/** Cost of one round trip at each leverage on a fixed margin. */
export function leverageRows(baseUsdt: number, leverages: number[], roundTripPercent: number): LeverageRow[] {
  return leverages.map((leverage) => {
    const notionalUsdt = baseUsdt * leverage;
    const costUsdt = (notionalUsdt * roundTripPercent) / 100;
    const costPercentOfAccount = (costUsdt / baseUsdt) * 100;
    return { leverage, notionalUsdt, costUsdt, costPercentOfAccount };
  });
}

/**
 * Approximate distance to liquidation, in percent of entry price, for an
 * isolated position at leverage L: 1/L minus the maintenance margin rate
 * (default 0.4%, Binance's lowest USDT-M tier). Larger positions sit in
 * higher maintenance tiers, so this is an upper bound: liquidation is at
 * most this far away.
 */
export function liquidationDistancePercent(leverage: number, maintenanceMarginRate = 0.004): number {
  return (1 / leverage - maintenanceMarginRate) * 100;
}

/** A round trip's cost as a share of the margin posted for it. */
export function costPercentOfMargin(roundTripPercent: number, leverage: number): number {
  return roundTripPercent * leverage;
}
