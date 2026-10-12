import type { FactorScores } from './factors';

export interface TargetAllocation {
  /** Map of symbol -> weight. Positive = long, negative = short, 0 = flat. */
  positions: Map<string, number>;
  /** Total portfolio turnover: sum of |newWeight - currentWeight|. */
  turnover: number;
  /** Whether any position changed during this evaluation. */
  rebalanced: boolean;
  /** Net exposure sum (should be ~0 for dollar-neutral). */
  netExposure: number;
  /** Gross exposure sum (sum of |weight|, should be 1.0 when fully invested). */
  grossExposure: number;
  /** Net beta exposure sum: sum of weight * beta (0 for beta-neutral). */
  netBetaExposure?: number;
}

export interface PortfolioConfig {
  /** Number of long and short legs (default 2). */
  legs?: number;
  /** Hysteresis buffer in ranks to suppress churn (default 1). */
  buffer?: number;
  /** Maximum single-side position weight cap (default 0.25). */
  weightPerLeg?: number;
  /** Optional asset beta to BTC mapping for beta-neutral weighting. */
  betas?: Map<string, number>;
}

/**
 * Constructs a dollar-neutral or beta-neutral portfolio across ranked symbols with turnover buffering.
 *
 * An asset currently held long is kept unless its rank falls strictly worse than (legs + buffer).
 * An asset currently held short is kept unless its rank rises strictly better than (N - legs - buffer + 1).
 * Vacant slots are filled from the highest/lowest available ranks.
 */
export function constructBufferedPortfolio(
  currentPositions: Map<string, number>,
  rankedScores: FactorScores[],
  config: PortfolioConfig = {}
): TargetAllocation {
  const n = rankedScores.length;
  const legs = config.legs ?? 2;
  const buffer = config.buffer ?? 1;

  if (2 * legs > n) {
    throw new Error(`Cannot assign ${legs} long and short legs from universe of size ${n}`);
  }

  const longExitRank = legs + buffer; // e.g. 2 + 1 = 3 -> exits if rank >= 4
  const shortExitRank = n - legs - buffer + 1; // e.g. 10 - 2 - 1 + 1 = 8 -> exits if rank <= 7

  if (longExitRank >= shortExitRank) {
    throw new Error(
      `Deadband overlap: longExitRank (${longExitRank}) >= shortExitRank (${shortExitRank}) with legs=${legs}, buffer=${buffer}, n=${n}`
    );
  }

  const retainedLongs: string[] = [];
  const retainedShorts: string[] = [];

  // 1. Evaluate existing holdings against hysteresis thresholds
  for (const [symbol, weight] of currentPositions.entries()) {
    if (weight > 0) {
      const item = rankedScores.find((r) => r.symbol === symbol);
      if (item && item.rank <= longExitRank) {
        retainedLongs.push(symbol);
      }
    } else if (weight < 0) {
      const item = rankedScores.find((r) => r.symbol === symbol);
      if (item && item.rank >= shortExitRank) {
        retainedShorts.push(symbol);
      }
    }
  }

  // Cap retained holdings to `legs` if buffer allowed too many
  const activeLongs = retainedLongs.slice(0, legs);
  const activeShorts = retainedShorts.slice(0, legs);

  // 2. Fill vacant long legs from the top ranks
  for (let i = 0; i < n && activeLongs.length < legs; i++) {
    const candidate = rankedScores[i].symbol;
    if (!activeLongs.includes(candidate) && !activeShorts.includes(candidate)) {
      activeLongs.push(candidate);
    }
  }

  // 3. Fill vacant short legs from the bottom ranks
  for (let i = n - 1; i >= 0 && activeShorts.length < legs; i--) {
    const candidate = rankedScores[i].symbol;
    if (!activeShorts.includes(candidate) && !activeLongs.includes(candidate)) {
      activeShorts.push(candidate);
    }
  }

  // 4. Determine leg weights (beta-neutral if betas provided, else dollar-neutral)
  const newPositions = new Map<string, number>();
  let longWeightPerLeg = config.weightPerLeg ?? 1 / (2 * legs);
  let shortWeightPerLeg = config.weightPerLeg ?? 1 / (2 * legs);

  if (config.betas && activeLongs.length > 0 && activeShorts.length > 0) {
    const avgLongBeta =
      activeLongs.reduce((acc, sym) => acc + (config.betas!.get(sym) ?? 1.0), 0) / activeLongs.length;
    const avgShortBeta =
      activeShorts.reduce((acc, sym) => acc + (config.betas!.get(sym) ?? 1.0), 0) / activeShorts.length;

    if (avgLongBeta > 0.1 && avgShortBeta > 0.1) {
      // W_L * avgLongBeta = W_S * avgShortBeta with W_L + W_S = 1.0
      const totalLongWeight = avgShortBeta / (avgLongBeta + avgShortBeta);
      const totalShortWeight = avgLongBeta / (avgLongBeta + avgShortBeta);
      longWeightPerLeg = totalLongWeight / activeLongs.length;
      shortWeightPerLeg = totalShortWeight / activeShorts.length;
    }
  }

  for (const sym of activeLongs) {
    newPositions.set(sym, longWeightPerLeg);
  }
  for (const sym of activeShorts) {
    newPositions.set(sym, -shortWeightPerLeg);
  }

  // 5. Compute turnover, exposure, and beta exposure metrics
  const allSymbols = new Set<string>([...currentPositions.keys(), ...newPositions.keys()]);
  let turnover = 0;
  let netExposure = 0;
  let grossExposure = 0;
  let netBetaExposure = 0;

  for (const sym of allSymbols) {
    const oldW = currentPositions.get(sym) ?? 0;
    const newW = newPositions.get(sym) ?? 0;
    const beta = config.betas?.get(sym) ?? 1.0;
    turnover += Math.abs(newW - oldW);
    netExposure += newW;
    grossExposure += Math.abs(newW);
    netBetaExposure += newW * beta;
  }

  return {
    positions: newPositions,
    turnover,
    rebalanced: turnover > 1e-6,
    netExposure,
    grossExposure,
    netBetaExposure,
  };
}
