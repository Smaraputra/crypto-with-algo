// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { RV_SYMBOLS, type RvPanel } from './rv-panel';
import { ANNUALISATION, rvV1NetTakerReturns, syntheticPanel } from './rv-synthetic';

const H8 = 8 * 3_600_000;
/** Header SEEDS: base 20261014, planted calibration universe k = 1..10 uses base + 210,000 + k. */
const BASE = 20261014;
const plantedSeed = (k: number) => BASE + 210_000 + k;

const logReturns = (p: RvPanel, s: number) => p.close[s].slice(1).map((c, i) => Math.log(c) - Math.log(p.close[s][i]));

const lag1 = (x: readonly number[]) => {
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    den += (x[i] - m) ** 2;
    if (i > 0) num += (x[i] - m) * (x[i - 1] - m);
  }
  return num / den;
};

const corr = (a: readonly number[], b: readonly number[]) => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
};

describe('syntheticPanel shapes and validity', () => {
  for (const mode of ['iid', 'garch', 'planted'] as const) {
    it(`${mode}: 10 symbols x 3,000 contiguous 8h bars, valid OHLC, taker-buy volume within volume, finite funding`, () => {
      const p = syntheticPanel({ bars: 3000, symbols: 10, mode, strength: mode === 'planted' ? 1 : 0, seed: 1 });
      expect(p.symbols).toEqual([...RV_SYMBOLS]);
      expect(p.t).toHaveLength(3000);
      expect(p.t[0] % H8).toBe(0);
      for (let i = 1; i < 3000; i++) expect(p.t[i] - p.t[i - 1]).toBe(H8);
      for (const col of [p.open, p.high, p.low, p.close, p.volume, p.tbv, p.fundSum, p.fundLast]) {
        expect(col).toHaveLength(10);
        for (const row of col) expect(row).toHaveLength(3000);
      }
      for (let s = 0; s < 10; s++) {
        for (let i = 0; i < 3000; i++) {
          expect(p.low[s][i]).toBeGreaterThan(0);
          expect(p.low[s][i]).toBeLessThanOrEqual(Math.min(p.open[s][i], p.close[s][i]));
          expect(p.high[s][i]).toBeGreaterThanOrEqual(Math.max(p.open[s][i], p.close[s][i]));
          expect(p.volume[s][i]).toBeGreaterThan(0);
          expect(p.tbv[s][i]).toBeGreaterThan(0);
          expect(p.tbv[s][i]).toBeLessThan(p.volume[s][i]);
          expect(Number.isFinite(p.fundSum[s][i])).toBe(true);
          expect(p.fundLast[s][i]).toBe(p.fundSum[s][i]); // one 8h settlement per bar, at its close
        }
      }
    });
  }

  it('is deterministic by seed and differs across seeds', () => {
    const a = syntheticPanel({ bars: 400, symbols: 10, mode: 'planted', strength: 1, seed: 5 });
    expect(syntheticPanel({ bars: 400, symbols: 10, mode: 'planted', strength: 1, seed: 5 })).toEqual(a);
    expect(syntheticPanel({ bars: 400, symbols: 10, mode: 'planted', strength: 1, seed: 6 }).close).not.toEqual(a.close);
    const g = syntheticPanel({ bars: 400, symbols: 10, mode: 'garch', strength: 0, seed: 5 });
    expect(syntheticPanel({ bars: 400, symbols: 10, mode: 'garch', strength: 0, seed: 5 })).toEqual(g);
  });

  it('rejects options it cannot honour instead of defaulting them', () => {
    const ok = { bars: 100, symbols: 10, mode: 'iid' as const, strength: 0, seed: 1 };
    expect(() => syntheticPanel({ ...ok, strength: 1 })).toThrow(/strength/);
    expect(() => syntheticPanel({ ...ok, mode: 'garch', strength: 0.5 })).toThrow(/strength/);
    expect(() => syntheticPanel({ ...ok, mode: 'planted', strength: -1 })).toThrow(/strength/);
    expect(() => syntheticPanel({ ...ok, symbols: 11 })).toThrow(/symbols/);
    expect(() => syntheticPanel({ ...ok, bars: 1 })).toThrow(/bars/);
    expect(() => syntheticPanel({ ...ok, seed: 1.5 })).toThrow(/seed/);
  });
});

describe('syntheticPanel driftless universes (header CALIBRATION: iid and GARCH)', () => {
  it('iid: no lag-1 autocorrelation in any symbol, and a realistic cross-sectional correlation', () => {
    const p = syntheticPanel({ bars: 3000, symbols: 10, mode: 'iid', strength: 0, seed: BASE + 200_001 });
    const rets = p.symbols.map((_, s) => logReturns(p, s));
    for (const r of rets) expect(Math.abs(lag1(r))).toBeLessThan(4 / Math.sqrt(r.length));
    const pairs: number[] = [];
    for (let a = 0; a < 10; a++) for (let b = a + 1; b < 10; b++) pairs.push(corr(rets[a], rets[b]));
    const mean = pairs.reduce((s, v) => s + v, 0) / pairs.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.9);
    // funding carries no persistence a carry factor could trade
    for (let s = 0; s < 10; s++) expect(Math.abs(lag1(p.fundSum[s]))).toBeLessThan(4 / Math.sqrt(3000));
  });

  it('garch: returns stay uncorrelated while squared returns cluster', () => {
    const p = syntheticPanel({ bars: 3000, symbols: 10, mode: 'garch', strength: 0, seed: BASE + 220_001 });
    const r = logReturns(p, 1);
    expect(Math.abs(lag1(r))).toBeLessThan(4 / Math.sqrt(r.length));
    expect(lag1(r.map((x) => x * x))).toBeGreaterThan(0.1);
  });
});

describe('syntheticPanel planted edge (header CALIBRATION: latent AR(1) score, kappa fixed once)', () => {
  it('funding is persistent and reads the score', () => {
    const p = syntheticPanel({ bars: 3000, symbols: 10, mode: 'planted', strength: 1, seed: plantedSeed(1) });
    for (let s = 0; s < 10; s++) expect(lag1(p.fundSum[s])).toBeGreaterThan(0.5);
  });

  it('gives rv-v1 an annualised net taker Sharpe in [3, 4] on at least 8 of the 10 header seeds', { timeout: 300_000 }, () => {
    const sharpes = Array.from({ length: 10 }, (_, j) => {
      const p = syntheticPanel({ bars: 3000, symbols: 10, mode: 'planted', strength: 1, seed: plantedSeed(j + 1) });
      return perPeriodSharpe(rvV1NetTakerReturns(p)) * ANNUALISATION;
    });
    expect(sharpes.filter((x) => x >= 3 && x <= 4).length).toBeGreaterThanOrEqual(8);
  });

  it('the iid universe gives rv-v1 no positive edge (annualised net Sharpe below 1)', { timeout: 60_000 }, () => {
    const p = syntheticPanel({ bars: 3000, symbols: 10, mode: 'iid', strength: 0, seed: BASE + 200_002 });
    expect(perPeriodSharpe(rvV1NetTakerReturns(p)) * ANNUALISATION).toBeLessThan(1);
  });
});

describe('rvV1NetTakerReturns (the reference rv-v1 run that fixes kappa)', () => {
  it('returns one open-to-open net return per signal bar from the first full window to the second-last bar', () => {
    const p = syntheticPanel({ bars: 200, symbols: 10, mode: 'planted', strength: 1, seed: 3 });
    const r = rvV1NetTakerReturns(p);
    expect(r).toHaveLength(200 - 43);
    expect(r.every((x) => Number.isFinite(x))).toBe(true);
    expect(r[0]).toBeLessThan(0); // the first step only pays the entry costs
  });

  it('refuses a panel whose bars are not contiguous', () => {
    const p = syntheticPanel({ bars: 100, symbols: 10, mode: 'iid', strength: 0, seed: 3 });
    const gap = { ...p, t: p.t.map((t, i) => (i >= 60 ? t + H8 : t)) };
    expect(() => rvV1NetTakerReturns(gap)).toThrow(/contiguous/);
  });
});
