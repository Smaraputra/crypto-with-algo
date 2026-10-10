// @vitest-environment node
/**
 * Evidence that BH and S carry no baseline bias: the driftless simulation below (10 symbols, 3,000
 * bars, martingale log prices with a common factor, tiers driven only by the trailing 12-bar return,
 * 12-bar forward returns) must centre BH at 0.5 and S at 0 over 30 seeds even though the tiers are
 * perfectly momentum-shaped and the symbols share a factor.
 */
import { describe, expect, it } from 'vitest';
import {
  blockBootstrap,
  bootstrapMeasures,
  cellMeasures,
  percentileType7,
  verdictOf,
  type LiveRow,
} from './live-record-stats';
import { seededRandom } from './carry-sim';

function row(tier: string, fwd: number, extra: Partial<LiveRow> = {}): LiveRow {
  return {
    symbol: 'BTCUSDT',
    interval: '5m',
    tradingStyle: 'scalping',
    tier,
    score: 0,
    configVersion: 8,
    candleTimestamp: 0,
    horizonBars: 12,
    forwardReturnPercent: fwd,
    ...extra,
  };
}

describe('cellMeasures', () => {
  const rows = [
    row('strong_buy', 2, { score: 60 }),
    row('buy', 1, { score: 40 }),
    row('buy', -1, { score: 35 }),
    row('buy', 0, { score: 30 }),
    row('neutral', 0.5, { score: 0 }),
    row('sell', -2, { score: -40 }),
    row('sell', 1, { score: -35 }),
    row('strong_sell', -3, { score: -60 }),
  ];
  const m = cellMeasures(rows, 0.2);

  it('computes BH with a zero return a hit for neither side', () => {
    // BUY fwd: 2, 1, -1, 0 -> 2/4 hits; SELL fwd: -2, 1, -3 -> 2/3 hits
    expect(m.buyN).toBe(4);
    expect(m.sellN).toBe(3);
    expect(m.bh).toBeCloseTo((0.5 + 2 / 3) / 2, 12);
  });

  it('computes S and N', () => {
    // mean BUY = 0.5, mean SELL = -4/3
    expect(m.s).toBeCloseTo(0.5 + 4 / 3, 12);
    // d x fwd: 2, 1, -1, 0, 2, -1, 3 = 6 over 7 rows
    expect(m.net).toBeCloseTo(6 / 7 - 0.2, 12);
  });

  it('reports tiers and the strong subset', () => {
    expect(m.tiers.buy.count).toBe(3);
    expect(m.tiers.buy.meanFwd).toBeCloseTo(0, 12);
    expect(m.tiers.buy.hitRate).toBeCloseTo(1 / 3, 12);
    expect(m.tiers.sell.hitRate).toBeCloseTo(0.5, 12);
    expect(m.tiers.neutral.count).toBe(1);
    expect(m.tiers.neutral.hitRate).toBeNaN();
    expect(m.strong.buyN).toBe(1);
    expect(m.strong.sellN).toBe(1);
    expect(m.strong.bh).toBe(1);
    expect(m.strong.s).toBe(5);
    expect(m.strong.net).toBeCloseTo(2.5 - 0.2, 12);
  });

  it('has a positive Spearman when higher scores precede higher returns', () => {
    expect(m.spearman).toBeGreaterThan(0);
    const inverted = cellMeasures(
      rows.map((r) => ({ ...r, score: -r.score })),
      0.2
    );
    expect(inverted.spearman).toBeCloseTo(-m.spearman, 12);
  });

  it('gives NaN, not a crash, when a side is empty', () => {
    const only = cellMeasures([row('buy', 1), row('buy', 2)], 0.1);
    expect(only.bh).toBeNaN();
    expect(only.s).toBeNaN();
    expect(only.net).toBeCloseTo(1.4, 12);
  });
});

describe('drift cancels', () => {
  it('leaves BH and S unchanged when a constant is added and no return crosses zero', () => {
    const rows = [
      row('buy', 5),
      row('buy', 7),
      row('buy', 6),
      row('strong_buy', 9),
      row('sell', 4),
      row('strong_sell', 6),
      row('sell', 8),
    ];
    const shifted = rows.map((r) => ({ ...r, forwardReturnPercent: r.forwardReturnPercent + 20 }));
    const a = cellMeasures(rows, 0);
    const b = cellMeasures(shifted, 0);
    expect(b.bh).toBe(a.bh);
    expect(b.s).toBeCloseTo(a.s, 12);
    // N is not drift-free: it moves by (buy share - sell share) x drift
    expect(b.net).not.toBeCloseTo(a.net, 6);
  });
});

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function simulate(seed: number): LiveRow[] {
  const random = seededRandom(seed);
  const symbols = 10;
  const bars = 3000;
  const h = 12;
  const sigma = 0.002;
  const logp: number[][] = Array.from({ length: symbols }, () => [0]);
  for (let t = 1; t <= bars; t++) {
    const common = gaussian(random) * sigma * 0.6;
    for (let s = 0; s < symbols; s++) {
      logp[s].push(logp[s][t - 1] + common + gaussian(random) * sigma * 0.8);
    }
  }
  // 15% normal tail is 1.036 sd of the 12-bar trailing return (sd = sqrt(0.36 + 0.64) * sigma * sqrt(12))
  const cut = 1.036 * sigma * Math.sqrt(h);
  const out: LiveRow[] = [];
  for (let s = 0; s < symbols; s++) {
    for (let t = h; t + h <= bars; t++) {
      const past = logp[s][t] - logp[s][t - h];
      const tier = past > cut ? 'buy' : past < -cut ? 'sell' : 'neutral';
      out.push(
        row(tier, (Math.exp(logp[s][t + h] - logp[s][t]) - 1) * 100, {
          symbol: `S${s}`,
          score: past,
          candleTimestamp: t * 300_000,
        })
      );
    }
  }
  return out;
}

describe('driftless simulation', () => {
  it('centres BH at 0.5 and S at 0 across 30 seeds', () => {
    const bhs: number[] = [];
    const ss: number[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const m = cellMeasures(simulate(seed), 0);
      bhs.push(m.bh);
      ss.push(m.s);
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const meanBh = mean(bhs);
    const meanS = mean(ss);
    const sdS = Math.sqrt(ss.reduce((a, b) => a + (b - meanS) ** 2, 0) / (ss.length - 1));
    const seS = sdS / Math.sqrt(ss.length);
    console.log(`driftless: mean BH ${meanBh.toFixed(5)}, mean S ${meanS.toFixed(5)}, se(S) ${seS.toFixed(5)}`);
    expect(Math.abs(meanBh - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(meanS)).toBeLessThan(2 * seS);
  }, 60_000);
});

function panel(timestamps: number, perTs: number, seed = 5): LiveRow[] {
  const random = seededRandom(seed);
  const rows: LiveRow[] = [];
  for (let t = 0; t < timestamps; t++) {
    for (let k = 0; k < perTs; k++) {
      const tier = random() < 0.5 ? 'buy' : 'sell';
      rows.push(row(tier, random() * 2 - 1, { symbol: `S${k}`, candleTimestamp: (t + 1) * 60_000 }));
    }
  }
  return rows;
}

describe('blockBootstrap', () => {
  const measure = (rs: LiveRow[]) => {
    const m = cellMeasures(rs, 0);
    return { bh: m.bh, s: m.s };
  };

  it('reproduces by seed and differs across seeds', () => {
    const rows = panel(60, 4);
    const a = blockBootstrap(rows, 6, measure, 200, 13);
    const b = blockBootstrap(rows, 6, measure, 200, 13);
    const c = blockBootstrap(rows, 6, measure, 200, 14);
    expect(a).toEqual(b);
    expect(a.bh.lo95).not.toBe(c.bh.lo95);
    expect(a.bh.finite).toBeGreaterThan(190);
    expect(a.bh.lo99).toBeLessThanOrEqual(a.bh.lo95);
    expect(a.bh.hi99).toBeGreaterThanOrEqual(a.bh.hi95);
  });

  it('keeps all rows of a timestamp together and fills exactly T positions', () => {
    const rows = panel(20, 3);
    const seen: LiveRow[][] = [];
    blockBootstrap(
      rows,
      5,
      (rs) => {
        seen.push(rs);
        return { n: rs.length };
      },
      50,
      3
    );
    for (const rs of seen) {
      expect(rs.length).toBe(60);
      const counts = new Map<number, number>();
      for (const r of rs) counts.set(r.candleTimestamp, (counts.get(r.candleTimestamp) ?? 0) + 1);
      for (const c of counts.values()) expect(c % 3).toBe(0);
    }
  });

  it('draws consecutive timeline positions within a block', () => {
    const rows = panel(30, 1);
    let consecutive = 0;
    let total = 0;
    blockBootstrap(
      rows,
      10,
      (rs) => {
        // 30 positions = 3 whole blocks of 10; inside each, timestamps step by exactly one bar
        for (let i = 0; i < rs.length; i++) {
          if (i % 10 === 0) continue;
          total++;
          if (rs[i].candleTimestamp - rs[i - 1].candleTimestamp === 60_000) consecutive++;
        }
        return { n: 1 };
      },
      20,
      9
    );
    expect(consecutive).toBe(total);
  });

  it('truncates the last block when L does not divide T', () => {
    const rows = panel(25, 2);
    blockBootstrap(rows, 10, (rs) => {
      expect(rs.length).toBe(50);
      return { n: 1 };
    }, 20, 1);
  });

  it('caps L at T when the timeline is shorter than a horizon, and handles empty input', () => {
    const rows = panel(4, 2);
    const out = blockBootstrap(rows, 50, (rs) => {
      expect(rs.length).toBe(8);
      return { n: rs.length };
    }, 10, 1);
    expect(out.n.lo95).toBe(8);
    expect(blockBootstrap([], 12, () => ({ n: 1 }), 10, 1)).toEqual({});
  });

  it('counts only finite resamples', () => {
    const rows = panel(10, 1);
    let call = 0;
    const out = blockBootstrap(rows, 3, () => ({ x: call++ % 2 === 0 ? 1 : NaN }), 10, 1);
    expect(out.x.finite).toBe(5);
  });
});

describe('blockBootstrap level option', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    symbol: 'X',
    interval: '1h',
    tradingStyle: 'day_trading',
    tier: i % 2 === 0 ? 'buy' : 'sell',
    score: i % 2 === 0 ? 30 : -30,
    configVersion: 8,
    candleTimestamp: i * 3_600_000,
    horizonBars: 5,
    forwardReturnPercent: ((i * 13) % 7) - 3,
  }));
  const fn = (rs: typeof rows) => bootstrapMeasures(rs, 0.1);

  it('adds level percentiles without changing the default fields', () => {
    const plain = blockBootstrap(rows, 5, fn, 100, 13);
    const withLevel = blockBootstrap(rows, 5, fn, 100, 13, 0.98);
    expect(plain.bh.loLevel).toBeUndefined();
    expect(withLevel.bh.lo99).toBe(plain.bh.lo99);
    expect(withLevel.bh.hi95).toBe(plain.bh.hi95);
    expect(withLevel.bh.loLevel).toBeLessThanOrEqual(withLevel.bh.hiLevel as number);
  });

  it('level 0.99 reproduces the 99% fields', () => {
    const r = blockBootstrap(rows, 5, fn, 100, 13, 0.99);
    expect(r.s.loLevel).toBeCloseTo(r.s.lo99, 12);
    expect(r.s.hiLevel).toBeCloseTo(r.s.hi99, 12);
  });
});

describe('percentileType7', () => {
  it('interpolates linearly', () => {
    expect(percentileType7([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentileType7([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
    expect(percentileType7([1, 2], 1)).toBe(2);
    expect(percentileType7([], 0.5)).toBeNaN();
  });
});

describe('verdictOf', () => {
  const ok = { spanHorizons: 10, buyN: 100, sellN: 100 };
  const iv = (lo: number, hi: number) => ({ lo99: lo, hi99: hi });

  it('is NOT ASSESSABLE by horizons', () => {
    const v = verdictOf({ ...ok, spanHorizons: 4.9, bh: iv(0.6, 0.7), s: iv(1, 2), net: iv(1, 2) });
    expect(v.verdict).toBe('NOT ASSESSABLE');
    expect(v.right || v.pays).toBe(false);
  });

  it('is NOT ASSESSABLE by side counts', () => {
    const base = { spanHorizons: 10, bh: iv(0.6, 0.7), s: iv(1, 2), net: iv(1, 2) };
    expect(verdictOf({ ...base, buyN: 29, sellN: 500 }).verdict).toBe('NOT ASSESSABLE');
    expect(verdictOf({ ...base, buyN: 500, sellN: 29 }).verdict).toBe('NOT ASSESSABLE');
    expect(verdictOf({ ...base, buyN: 30, sellN: 30 }).verdict).toBe('RIGHT');
  });

  it('is RIGHT only when BH - 0.5 and S are both above zero, and records PAYS too', () => {
    const v = verdictOf({ ...ok, bh: iv(0.51, 0.55), s: iv(0.1, 0.4), net: iv(0.05, 0.3) });
    expect(v.verdict).toBe('RIGHT');
    expect(v.right).toBe(true);
    expect(v.pays).toBe(true);
    expect(v.halfWidths.bh).toBeCloseTo(0.02, 12);
    expect(v.level).toBe(0.99);
    expect(verdictOf({ ...ok, bh: iv(0.49, 0.55), s: iv(0.1, 0.4), net: iv(-1, -0.5) }).right).toBe(false);
    expect(verdictOf({ ...ok, bh: iv(0.51, 0.55), s: iv(-0.1, 0.4), net: iv(-1, -0.5) }).right).toBe(false);
  });

  it('is WRONG-WAY when both lie below', () => {
    const v = verdictOf({ ...ok, bh: iv(0.4, 0.49), s: iv(-0.4, -0.1), net: iv(-1, -0.5) });
    expect(v.verdict).toBe('WRONG-WAY');
    expect(v.wrongWay).toBe(true);
    expect(verdictOf({ ...ok, bh: iv(0.4, 0.49), s: iv(-0.4, 0.1), net: iv(-1, -0.5) }).wrongWay).toBe(false);
  });

  it('is PAYS when only N is above zero, else NO DETECTABLE EDGE', () => {
    expect(verdictOf({ ...ok, bh: iv(0.45, 0.55), s: iv(-0.2, 0.2), net: iv(0.1, 0.5) }).verdict).toBe('PAYS');
    const none = verdictOf({ ...ok, bh: iv(0.45, 0.55), s: iv(-0.2, 0.2), net: iv(-0.5, 0.1) });
    expect(none.verdict).toBe('NO DETECTABLE EDGE');
    expect(none.halfWidths.s).toBeCloseTo(0.2, 12);
  });

  it('records a custom level, defaults to 0.99, and applies the same rules at that level', () => {
    const level = 1 - 0.05 / 6;
    const input = { ...ok, bh: iv(0.51, 0.55), s: iv(0.1, 0.4), net: iv(-1, -0.5) };
    const custom = verdictOf(input, level);
    expect(custom.level).toBe(level);
    expect(custom.verdict).toBe('RIGHT');
    expect(verdictOf(input).level).toBe(0.99);
    expect(verdictOf(input)).toEqual({ ...custom, level: 0.99 });
  });

  it('treats NaN intervals as no edge', () => {
    const v = verdictOf({ ...ok, bh: iv(NaN, NaN), s: iv(NaN, NaN), net: iv(NaN, NaN) });
    expect(v.verdict).toBe('NO DETECTABLE EDGE');
  });
});

describe('bootstrapMeasures', () => {
  it('equals cellMeasures on the shared keys', () => {
    const rows = simulate(2).slice(0, 5000).map((r, i) => ({
      ...r,
      tier: i % 7 === 0 ? 'strong_buy' : i % 11 === 0 ? 'strong_sell' : r.tier,
    }));
    const full = cellMeasures(rows, 0.16);
    const fast = bootstrapMeasures(rows, 0.16);
    expect(fast.bh).toBeCloseTo(full.bh, 12);
    expect(fast.s).toBeCloseTo(full.s, 12);
    expect(fast.net).toBeCloseTo(full.net, 12);
    expect(fast.strongBh).toBeCloseTo(full.strong.bh, 12);
    expect(fast.strongS).toBeCloseTo(full.strong.s, 12);
    expect(fast.strongNet).toBeCloseTo(full.strong.net, 12);
  });
});
