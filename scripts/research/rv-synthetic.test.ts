// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { RV_V1 } from '@/lib/signals/cross-sectional/engine';
import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { RV_SYMBOLS, type RvPanel } from './rv-panel';
import { ANNUALISATION, rvV1NetTakerReturns, rvV1TakerSteps, syntheticPanel, syntheticPanelWithScores } from './rv-synthetic';

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
  it('iid and garch panels do not depend on the latent score at all, while planted panels do (review m8)', () => {
    const other = (seed: number) => {
      const random = createSeededRandom(seed);
      return Array.from({ length: 10 }, () => Array.from({ length: 300 }, () => (random() - 0.5) * 8));
    };
    for (const mode of ['iid', 'garch'] as const) {
      const opts = { bars: 300, symbols: 10, mode, strength: 0, seed: 77 };
      expect(syntheticPanelWithScores(opts, other(1))).toEqual(syntheticPanel(opts));
    }
    const planted = { bars: 300, symbols: 10, mode: 'planted' as const, strength: 1, seed: 77 };
    const replaced = syntheticPanelWithScores(planted, other(1));
    const base = syntheticPanel(planted);
    expect(replaced.close).not.toEqual(base.close);
    expect(replaced.fundSum).not.toEqual(base.fundSum);
    expect(replaced.tbv).not.toEqual(base.tbv);
    expect(() => syntheticPanelWithScores(planted, other(1).slice(1))).toThrow(/scores/);
  });

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

  it('gives rv-v1 a ten-seed mean annualised net taker Sharpe in [3, 4], pinned at 3.504, with 8 of 10 seeds in the band', { timeout: 300_000 }, () => {
    const sharpes = Array.from({ length: 10 }, (_, j) => {
      const p = syntheticPanel({ bars: 3000, symbols: 10, mode: 'planted', strength: 1, seed: plantedSeed(j + 1) });
      return perPeriodSharpe(rvV1NetTakerReturns(p)) * ANNUALISATION;
    });
    const mean = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
    // AMENDMENT 1 reads "lies in [3, 4]" as the population edge, the ten-seed mean
    expect(mean).toBeGreaterThanOrEqual(3);
    expect(mean).toBeLessThanOrEqual(4);
    expect(mean).toBeCloseTo(3.504, 2); // regression value recorded in AMENDMENT 1
    expect(sharpes.filter((x) => x >= 3 && x <= 4).length).toBeGreaterThanOrEqual(8);
  });

  it('the iid universe gives rv-v1 no positive edge (annualised net Sharpe below 1)', { timeout: 60_000 }, () => {
    const p = syntheticPanel({ bars: 3000, symbols: 10, mode: 'iid', strength: 0, seed: BASE + 200_002 });
    expect(perPeriodSharpe(rvV1NetTakerReturns(p)) * ANNUALISATION).toBeLessThan(1);
  });
});

describe('rvV1NetTakerReturns timing (an independent oracle for the 7B parity target, review I5)', () => {
  const base = syntheticPanel({ bars: 200, symbols: 10, mode: 'planted', strength: 1, seed: 11 });
  const full = rvV1NetTakerReturns(base);
  const edit = (f: (p: RvPanel) => void): RvPanel => {
    const p = structuredClone(base);
    f(p);
    return p;
  };
  const firstDiff = (a: number[], b: number[]) => a.findIndex((x, i) => x !== b[i]);

  it('is causal: the run on the panel cut after bar n equals the first n - 43 returns of the full run', () => {
    for (const n of [60, 120, 199]) {
      const cut = edit((p) => {
        p.t = p.t.slice(0, n);
        const cols = p as unknown as Record<string, unknown[][]>;
        for (const col of ['open', 'high', 'low', 'close', 'volume', 'tbv', 'fundSum', 'fundLast']) cols[col] = cols[col].map((row) => row.slice(0, n));
      });
      expect(rvV1NetTakerReturns(cut)).toEqual(full.slice(0, n - 43));
    }
  });

  it('charges bar k\'s funding in the step that fills at open k + 1, and nothing earlier', () => {
    const k = 100;
    const r = rvV1NetTakerReturns(edit((p) => p.fundSum.forEach((row) => (row[k] += 0.001))));
    expect(firstDiff(r, full)).toBe(k - 42);
  });

  it('fills and marks at open k + 1: its open moves step k, while its close, high and low do not', () => {
    const k = 100;
    const byOpen = rvV1NetTakerReturns(edit((p) => p.open.forEach((row) => (row[k + 1] *= 1.01))));
    expect(firstDiff(byOpen, full)).toBe(k - 42);
    const byRest = rvV1NetTakerReturns(
      edit((p) => {
        p.close.forEach((row) => (row[k + 1] *= 1.01));
        p.high.forEach((row) => (row[k + 1] *= 1.02));
        p.low.forEach((row) => (row[k + 1] *= 0.98));
      })
    );
    const d = firstDiff(byRest, full);
    expect(d === -1 || d > k - 42).toBe(true);
  });

  it('matches a hand computation of every step: price move open k to open k + 1, bar k funding, then trade costs at open k + 1', () => {
    const steps = rvV1TakerSteps(base);
    expect(steps.map((x) => x.ret)).toEqual(full);
    const slip = RV_V1.costs.takerSlippageBps / 1e4;
    const fee = RV_V1.costs.takerFee;
    let heldLegs = 0;
    for (let j = 1; j < steps.length; j++) {
      const k = steps[j].k;
      expect(k).toBe(42 + j);
      expect(steps[j].before).toEqual(steps[j - 1].after);
      const eqPrev = steps[j - 1].equityAfter;
      let equity = eqPrev;
      const idx = (sym: string) => base.symbols.indexOf(sym);
      for (const [sym, pos] of Object.entries(steps[j].before.positions)) {
        const s = idx(sym);
        expect(pos.lastMark).toBe(base.open[s][k]);
        equity += pos.qty * (base.open[s][k + 1] - base.open[s][k]);
        equity -= pos.qty * base.open[s][k] * base.fundSum[s][k];
        heldLegs++;
      }
      for (const sym of base.symbols) {
        const s = idx(sym);
        const delta = (steps[j].after.positions[sym]?.qty ?? 0) - (steps[j].before.positions[sym]?.qty ?? 0);
        if (Math.abs(delta) <= 1e-12) continue;
        const ref = base.open[s][k + 1];
        const price = ref * (1 + Math.sign(delta) * slip);
        equity -= Math.abs(delta) * ref * slip + Math.abs(delta) * price * fee;
      }
      expect(Math.abs(steps[j].equityAfter / equity - 1)).toBeLessThan(1e-10);
      expect(Math.abs(steps[j].ret - (equity / eqPrev - 1))).toBeLessThan(1e-10);
    }
    expect(heldLegs).toBeGreaterThan(4 * 100);
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
