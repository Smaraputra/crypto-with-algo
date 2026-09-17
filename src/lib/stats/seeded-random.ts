/**
 * Deterministic pseudo-random number generator (mulberry32).
 * Given the same seed, produces the same sequence of values every time,
 * so statistics built on it (bootstrap resampling, Monte Carlo checks) are
 * reproducible across runs.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return function random(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
