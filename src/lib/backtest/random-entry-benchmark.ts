import type { EntryDecision, Strategy, StrategyContext } from './strategy';
import type { PreparedBacktest } from './optimized-engine';
import { runOptimizedBacktest } from './optimized-engine';
import type { BacktestConfig, BacktestResult, TradeSide } from './types';

/**
 * The shape of a reference run's trades a random strategy needs to imitate:
 * how often it entered, its long/short mix, and the hold time, stop, and
 * target distances actually realized. Sampling from these arrays (rather
 * than a parametric distribution) keeps the random strategy's trade shape
 * tied to what the reference really did, including any skew or outliers.
 */
export interface ReferenceProfile {
  entryProbability: number;
  longShare: number;
  holdBars: number[];
  stopPercents: number[];
  rewardPercents: (number | null)[];
}

/**
 * Builds a ReferenceProfile from a reference BacktestResult.
 *
 * entryProbability is trades divided by the reference's flat-bar count:
 * `totalBars` (the post-warmup bar count both engines derive as
 * `candles.length - warmupBars` in bar-loop.ts) minus the bars actually
 * spent holding a position (the sum of every trade's `holdTimeBars`),
 * floored at 1 bar, then clamped to (0, 1]. decideEntry is only ever called
 * on a bar the engine is flat -- never while a position or a pending order
 * is open -- so dividing by totalBars understated the true per-flat-bar
 * rate whenever trades held for more than a few bars: a random strategy run
 * through the same `prepared` data then entered less often than the
 * reference, since it also only gets a decideEntry call on its own flat
 * bars. Dividing by the flat-bar count instead reproduces the reference's
 * trade count in expectation.
 */
export function referenceProfile(result: BacktestResult): ReferenceProfile {
  const { trades, totalBars } = result;

  if (trades.length === 0) {
    throw new Error('referenceProfile requires a reference result with at least one trade');
  }

  const longTrades = trades.filter((t) => t.side === 'long').length;
  const heldBars = trades.reduce((sum, t) => sum + t.holdTimeBars, 0);
  const flatBars = Math.max(1, totalBars - heldBars);

  return {
    entryProbability: Math.min(1, trades.length / flatBars),
    longShare: longTrades / trades.length,
    holdBars: trades.map((t) => t.holdTimeBars),
    stopPercents: trades.map((t) => t.riskPercent ?? 0),
    rewardPercents: trades.map((t) => t.rewardPercent),
  };
}

/** Small, dependency-free PRNG (mulberry32, public domain). src/lib/stats's
 * seeded generator is not available on this branch; this is sufficient for
 * a deterministic, reproducible-by-seed sample sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function random(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A Strategy that enters randomly at the reference's own rate, side mix, and
 * hold/stop/target distances, and never exits by signal (so stop, target,
 * time stop, or end of data drive every exit, exactly like the reference).
 * Deterministic for a given seed: the same seed always draws the same
 * sequence of entries against the same candle series.
 */
export function createRandomEntryStrategy(profile: ReferenceProfile, seed: number): Strategy {
  const random = mulberry32(seed);
  const sampleCount = profile.holdBars.length;

  return {
    name: 'random-entry-benchmark',
    params: { seed },

    decideEntry(ctx: StrategyContext): EntryDecision | null {
      if (random() >= profile.entryProbability) return null;

      const side: TradeSide = random() < profile.longShare ? 'long' : 'short';
      const index = Math.min(sampleCount - 1, Math.floor(random() * sampleCount));
      const stopPercent = profile.stopPercents[index];
      const rewardPercent = profile.rewardPercents[index];
      const close = ctx.candles[ctx.bar].close;

      return {
        side,
        orderType: 'market',
        stopPrice: side === 'long' ? close * (1 - stopPercent / 100) : close * (1 + stopPercent / 100),
        targetPrice:
          rewardPercent === null
            ? null
            : side === 'long'
              ? close * (1 + rewardPercent / 100)
              : close * (1 - rewardPercent / 100),
        timeStopBars: profile.holdBars[index],
      };
    },

    decideExit(): boolean {
      return false;
    },
  };
}

/**
 * Runs `opts.iterations` random-entry strategies, seeded `opts.seed + k`,
 * through the same prepared data, config, costs, and funding as the
 * reference, and compares each run's expectancy to the reference's. The
 * p-value answers whether the reference's entry timing (as opposed to its
 * exits, which the random strategies share) beats chance: it is the share of
 * random draws that matched or beat the observed expectancy, with a
 * pseudo-count of 1 in numerator and denominator so it is never exactly 0.
 *
 * This tests entry timing given the realized exit timing distribution (the
 * reference's own hold/stop/target sample), not the exit rule itself: a
 * strategy with a genuinely better exit rule, not a better entry, can still
 * score a low p-value here, since every random draw exits the same way the
 * reference did.
 */
export function randomEntryBenchmark(
  prepared: PreparedBacktest,
  config: BacktestConfig,
  symbol: string,
  interval: string,
  reference: BacktestResult,
  opts: { iterations: number; seed: number }
): {
  observedExpectancy: number;
  randomExpectancies: number[];
  pValue: number;
  meanRandom: number;
  sdRandom: number;
} {
  const profile = referenceProfile(reference);
  const observedExpectancy = reference.metrics.expectancyPercent;

  const randomExpectancies: number[] = [];
  for (let k = 0; k < opts.iterations; k++) {
    const strategy = createRandomEntryStrategy(profile, opts.seed + k);
    const result = runOptimizedBacktest(prepared, config, symbol, interval, undefined, strategy);
    randomExpectancies.push(result.metrics.expectancyPercent);
  }

  const meanRandom = randomExpectancies.reduce((sum, v) => sum + v, 0) / randomExpectancies.length;
  const variance =
    randomExpectancies.length > 1
      ? randomExpectancies.reduce((sum, v) => sum + (v - meanRandom) ** 2, 0) /
        (randomExpectancies.length - 1)
      : 0;
  const sdRandom = Math.sqrt(variance);

  const countAtOrAbove = randomExpectancies.filter((v) => v >= observedExpectancy).length;
  const pValue = (1 + countAtOrAbove) / (opts.iterations + 1);

  return { observedExpectancy, randomExpectancies, pValue, meanRandom, sdRandom };
}
