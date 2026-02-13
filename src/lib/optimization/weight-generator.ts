import type { SignalWeights } from '@/types/signal';

/**
 * Seeded random number generator for reproducibility
 */
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    // Linear congruential generator
    this.seed = (this.seed * 1664525 + 1013904223) % 2 ** 32;
    return this.seed / 2 ** 32;
  }
}

/**
 * Generate random weights within ±constraint% of base template
 * Ensures sum = 1.0 via normalization
 */
export function generateConstrainedWeights(
  baseWeights: SignalWeights,
  constraintPercent: number,
  rng: SeededRandom
): SignalWeights {
  const categories: Array<keyof SignalWeights> = [
    'trend',
    'momentum',
    'volume',
    'volatility',
    'futures',
    'sentiment',
  ];

  // Generate constrained random values
  const raw: Partial<SignalWeights> = {};
  for (const cat of categories) {
    const base = baseWeights[cat];
    const min = base * (1 - constraintPercent);
    const max = base * (1 + constraintPercent);
    raw[cat] = min + rng.next() * (max - min);
  }

  // Normalize to sum = 1.0
  const sum = categories.reduce((acc, cat) => acc + (raw[cat] ?? 0), 0);
  const normalized: SignalWeights = {
    trend: (raw.trend ?? 0) / sum,
    momentum: (raw.momentum ?? 0) / sum,
    volume: (raw.volume ?? 0) / sum,
    volatility: (raw.volatility ?? 0) / sum,
    futures: (raw.futures ?? 0) / sum,
    sentiment: (raw.sentiment ?? 0) / sum,
  };

  return normalized;
}

/**
 * Generate N unique weight candidates
 * Uses seeded randomness for reproducibility
 */
export function generateWeightCandidates(
  baseWeights: SignalWeights,
  count: number,
  constraintPercent: number,
  seed = 42
): SignalWeights[] {
  const rng = new SeededRandom(seed);
  const candidates: SignalWeights[] = [];

  // Include base weights as first candidate
  candidates.push({ ...baseWeights });

  // Generate constrained random candidates
  for (let i = 1; i < count; i++) {
    const weights = generateConstrainedWeights(baseWeights, constraintPercent, rng);
    candidates.push(weights);
  }

  return candidates;
}

/**
 * Average weights from multiple weight sets
 * Used for ensemble averaging
 */
export function averageWeights(weightSets: SignalWeights[]): SignalWeights {
  if (weightSets.length === 0) {
    throw new Error('Cannot average empty weight sets');
  }

  const categories: Array<keyof SignalWeights> = [
    'trend',
    'momentum',
    'volume',
    'volatility',
    'futures',
    'sentiment',
  ];

  const sums: Partial<SignalWeights> = {};
  for (const cat of categories) {
    sums[cat] = weightSets.reduce((acc, w) => acc + w[cat], 0);
  }

  const count = weightSets.length;
  return {
    trend: (sums.trend ?? 0) / count,
    momentum: (sums.momentum ?? 0) / count,
    volume: (sums.volume ?? 0) / count,
    volatility: (sums.volatility ?? 0) / count,
    futures: (sums.futures ?? 0) / count,
    sentiment: (sums.sentiment ?? 0) / count,
  };
}

/**
 * Validate weights sum to 1.0 (within floating point tolerance)
 */
export function validateWeights(weights: SignalWeights): boolean {
  const sum =
    weights.trend +
    weights.momentum +
    weights.volume +
    weights.volatility +
    weights.futures +
    weights.sentiment;

  const tolerance = 1e-10;
  return Math.abs(sum - 1.0) < tolerance && Object.values(weights).every((w) => w >= 0);
}
