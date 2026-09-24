// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  correlation,
  crossSections,
  panelIcStats,
  verdictFor,
  type PanelObservation,
} from './llm-factor-stats';

const BAR = 3_600_000;

function obs(
  bar: number,
  entries: Array<[symbol: string, score: number, fwd: number]>
): PanelObservation[] {
  return entries.map(([symbol, score, forwardReturnPercent]) => ({
    symbol,
    candleTimestamp: bar,
    score,
    forwardReturnPercent,
  }));
}

describe('correlation', () => {
  it('is +1 for a perfectly increasing relationship', () => {
    expect(correlation([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it('is -1 for a perfectly decreasing relationship', () => {
    expect(correlation([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('is NaN when a side has no variance', () => {
    expect(correlation([1, 1, 1, 1], [1, 2, 3, 4])).toBeNaN();
  });

  it('is NaN below three pairs', () => {
    expect(correlation([1, 2], [1, 2])).toBeNaN();
  });
});

describe('crossSections', () => {
  it('groups by bar and orders oldest first', () => {
    const groups = crossSections(
      [
        ...obs(2 * BAR, [['A', 1, 1], ['B', 2, 2], ['C', 3, 3]]),
        ...obs(1 * BAR, [['A', 1, 1], ['B', 2, 2], ['C', 3, 3]]),
      ],
      3
    );

    expect(groups).toHaveLength(2);
    expect(groups[0][0].candleTimestamp).toBe(1 * BAR);
    expect(groups[1][0].candleTimestamp).toBe(2 * BAR);
  });

  it('drops bars narrower than the minimum cross-section', () => {
    // Demeaning a two-symbol bar leaves +d and -d, which carries almost no
    // information and produces an IC of exactly +/-1 by construction.
    const groups = crossSections(
      [...obs(BAR, [['A', 1, 1], ['B', 2, 2]]), ...obs(2 * BAR, [['A', 1, 1], ['B', 2, 2], ['C', 3, 3]])],
      3
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('drops non-finite scores and returns', () => {
    const groups = crossSections(
      [
        ...obs(BAR, [['A', 1, 1], ['B', 2, 2], ['C', 3, 3], ['D', 4, 4]]),
        { symbol: 'E', candleTimestamp: BAR, score: NaN, forwardReturnPercent: 5 },
        { symbol: 'F', candleTimestamp: BAR, score: 5, forwardReturnPercent: NaN },
      ],
      3
    );

    expect(groups[0]).toHaveLength(4);
  });
});

describe('panelIcStats', () => {
  it('removes market beta, which a raw IC leaves in', () => {
    // Every symbol rose 10%, plus a spread that is the OPPOSITE of the call.
    // The raw returns are all positive, so a per-tier mean would read every
    // tier as a winner; only demeaning exposes the inverted cross-section.
    // Spread is exactly -score/20, so a perfect inversion, on top of +10.
    const observations = obs(BAR, [
      ['A', 80, 10 - 4],
      ['B', 40, 10 - 2],
      ['C', -40, 10 + 2],
      ['D', -80, 10 + 4],
    ]);

    const stats = panelIcStats(observations, 24);

    expect(stats.demeanedIc).toBeCloseTo(-1, 6);
    expect(stats.rawIc).toBeCloseTo(-1, 6);
    // Every raw return is positive despite a perfectly inverted call.
    expect(observations.every((o) => o.forwardReturnPercent > 0)).toBe(true);
  });

  it('reports a positive IC when the call ranks the cross-section correctly', () => {
    const stats = panelIcStats(
      // Returns are exactly score/20, so a perfect ranking.
      obs(BAR, [
        ['A', 80, 4],
        ['B', 40, 2],
        ['C', -40, -2],
        ['D', -80, -4],
      ]),
      24
    );

    expect(stats.demeanedIc).toBeCloseTo(1, 6);
    expect(stats.barsPositive).toBe(1);
  });

  it('converts bars to independent windows using the horizon', () => {
    // 48 bars at a 24-bar horizon is two non-overlapping forward windows,
    // however many observations those bars contain.
    const observations = Array.from({ length: 48 }, (_, i) =>
      obs(i * BAR, [['A', 10, 1], ['B', -10, -1], ['C', 5, 0.5]])
    ).flat();

    const stats = panelIcStats(observations, 24);

    expect(stats.bars).toBe(48);
    expect(stats.independentWindows).toBeCloseTo(2, 6);
    expect(stats.n).toBe(144);
  });

  it('reports the inflation factor a naive t-stat carries', () => {
    const observations = Array.from({ length: 24 }, (_, i) =>
      obs(i * BAR, [['A', 10, 1], ['B', -10, -1], ['C', 5, 0.5]])
    ).flat();

    const stats = panelIcStats(observations, 24);

    // 24 bars over a 24-bar horizon is one window; the naive t is overstated
    // by sqrt(24/1) ~ 4.9.
    expect(stats.independentWindows).toBeCloseTo(1, 6);
    expect(stats.inflationFactor).toBeCloseTo(Math.sqrt(24), 6);
  });

  it('refuses to call a short record readable however large n is', () => {
    // The shape of the first real read: many observations, almost no
    // independent windows.
    const observations = Array.from({ length: 15 }, (_, i) =>
      obs(i * BAR, [['A', 80, -1], ['B', 40, 0], ['C', -40, 1], ['D', -80, 2]])
    ).flat();

    const stats = panelIcStats(observations, 24);

    expect(stats.n).toBe(60);
    expect(stats.independentWindows).toBeLessThan(1);
    expect(stats.verdict).toMatch(/NOT READABLE/);
    expect(stats.verdict).toMatch(/1 independent observation/);
  });

  it('handles an empty record without throwing', () => {
    const stats = panelIcStats([], 24);

    expect(stats.n).toBe(0);
    expect(stats.bars).toBe(0);
    expect(stats.verdict).toMatch(/too few cross-sections/);
  });
});

describe('verdictFor', () => {
  it.each([
    [1, 0.04, 1, /too few cross-sections/],
    [15, 0.6, 15, /NOT READABLE/],
    [120, 5, 120, /DIRECTIONAL ONLY/],
    [480, 20, 480, /WEAK/],
    [1200, 50, 1200, /worth reading/],
  ])('reads %i bars / %s windows as expected', (bars, windows, icBars, pattern) => {
    expect(verdictFor(bars, windows, icBars)).toMatch(pattern);
  });

  it('puts the independent-window count in the message, not the bar count', () => {
    // The bar count is the number that misleads; the window count is the one
    // that constrains the claim, so it is the one that must be visible.
    expect(verdictFor(600, 25, 600)).toContain('25.0');
  });
});
