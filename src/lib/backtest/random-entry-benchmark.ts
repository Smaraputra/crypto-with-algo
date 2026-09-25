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
 * bars.
 *
 * This is the STARTING point, not the final rate. It reproduces the
 * reference's trade count in expectation only if the random strategy's
 * realized holds match the reference's, and they systematically do not: the
 * reference's `holdTimeBars` are realized holds that already embed its own
 * stop and target hits, and `createRandomEntryStrategy` then re-applies the
 * stop AND the target AND uses that realized hold as a `timeStopBars` cap, so
 * a random trade gets three chances to be cut short where the reference's
 * outcome was already settled. Measured, the random runs' mean hold is a
 * consistent 0.76 to 0.77 of the reference's, and since shorter holds mean
 * more flat bars they mean more entries: 1.17x the reference's trade count at
 * 5 reference trades, 1.29x at 8. `randomEntryBenchmark` therefore calibrates
 * this rate against the realized holds before drawing its null; see
 * `entryProbabilityForTargetTrades`.
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
 * The per-flat-bar entry probability whose expected trade count is
 * `targetTrades`, given the mean hold a trade actually realizes.
 *
 * With probability `p` on each flat bar, expected trades `T'` satisfy
 * `T' = p * (totalBars - T' * h)`, so `T' = p * totalBars / (1 + p * h)`.
 * Setting `T' = targetTrades` and solving gives the expression below. Passing
 * the REFERENCE's mean hold returns `referenceProfile`'s own rate, which is
 * why that rate over-trades whenever the realized hold is shorter.
 */
export function entryProbabilityForTargetTrades(
  targetTrades: number,
  totalBars: number,
  meanRealizedHold: number
): number {
  const flatBars = totalBars - targetTrades * meanRealizedHold;
  // A reference that spends essentially all its bars in a position leaves no
  // room to be matched on count; entering on every flat bar is the closest
  // the null can get.
  if (!(flatBars > 0)) return 1;
  return Math.min(1, targetTrades / flatBars);
}

/** Pilot draws per calibration round. Enough for a stable mean hold without
 * materially adding to the benchmark's cost. */
const CALIBRATION_DRAWS = 8;

/** Calibration rounds. The mean hold barely moves with the entry rate, so this
 * converges in one or two; the third is headroom. */
const CALIBRATION_ROUNDS = 3;

/** Keeps pilot seeds off the null's own stream (`opts.seed + k`), the same
 * separation `exposure-harness.ts` uses for its timing draws. */
const CALIBRATION_SEED_OFFSET = 1_000_000;

/** Relative change in the entry rate below which calibration stops early. */
const CALIBRATION_TOLERANCE = 0.01;

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
  /** Mean trade count across the random draws, for comparison with the
   * reference's. A null that does not reproduce the reference's trade count is
   * not matched on anything but its exit profile. */
  meanRandomTrades: number;
  /** The entry probability actually used, after calibration. */
  entryProbability: number;
} {
  const observedExpectancy = reference.metrics.expectancyPercent;
  const targetTrades = reference.trades.length;

  // Calibrate the entry rate against the hold the random strategy actually
  // realizes, not the one the reference realized. Seeded, so a report still
  // reproduces exactly.
  let profile = referenceProfile(reference);
  for (let round = 0; round < CALIBRATION_ROUNDS; round++) {
    let heldBars = 0;
    let trades = 0;
    for (let k = 0; k < CALIBRATION_DRAWS; k++) {
      const pilot = runOptimizedBacktest(
        prepared,
        config,
        symbol,
        interval,
        undefined,
        createRandomEntryStrategy(profile, opts.seed + CALIBRATION_SEED_OFFSET + round * 1000 + k)
      );
      for (const trade of pilot.trades) {
        heldBars += trade.holdTimeBars;
        trades++;
      }
    }
    // No pilot trade means the rate is already too low to measure a hold from;
    // leave it where it is rather than guess.
    if (trades === 0) break;

    const next = entryProbabilityForTargetTrades(
      targetTrades,
      reference.totalBars,
      heldBars / trades
    );
    if (!Number.isFinite(next) || next <= 0) break;

    const converged =
      Math.abs(next - profile.entryProbability) / profile.entryProbability < CALIBRATION_TOLERANCE;
    profile = { ...profile, entryProbability: next };
    if (converged) break;
  }

  const randomExpectancies: number[] = [];
  let tradeCountTotal = 0;
  for (let k = 0; k < opts.iterations; k++) {
    const strategy = createRandomEntryStrategy(profile, opts.seed + k);
    const result = runOptimizedBacktest(prepared, config, symbol, interval, undefined, strategy);
    randomExpectancies.push(result.metrics.expectancyPercent);
    tradeCountTotal += result.trades.length;
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

  return {
    observedExpectancy,
    randomExpectancies,
    pValue,
    meanRandom,
    sdRandom,
    meanRandomTrades: tradeCountTotal / opts.iterations,
    entryProbability: profile.entryProbability,
  };
}
