// scripts/research/direction-exit-diagnosis.test.ts
import { describe, expect, it } from 'vitest';
import { seededRandom } from './carry-sim';
import { CATEGORIES, type DxRow } from './direction-exit-rows';
import { conditionHolds, d1Score, diagnose, volTopThresholds } from './direction-exit-diagnosis';

const HOUR = 3_600_000;
const cats = (v: number | null) => Object.fromEntries(CATEGORIES.map((c) => [c, v])) as DxRow['cats'];

function randomWalkRows(n: number, seed: number): DxRow[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, (_, i) => {
    const score = (rnd() - 0.5) * 100;
    const steps = Array.from({ length: 24 }, () => (rnd() - 0.5) * 2);
    let p = 0;
    let hi = 0;
    let lo = 0;
    for (const s of steps) {
      p += s;
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    return {
      symbol: i % 2 === 0 ? 'BTCUSDT' : 'ETHUSDT', interval: '1h', style: 'day_trading', t: i * HOUR,
      score, tier: score > 36 ? 'strong_buy' : score > 28 ? 'buy' : score < -36 ? 'strong_sell' : score < -28 ? 'sell' : 'neutral',
      cats: cats((rnd() - 0.5) * 100), vol20: rnd(), hourUtc: i % 24, atrPct: 1,
      fwd: p, fwd1: p, up: hi, down: lo, up1: hi, down1: lo,
    };
  });
}

describe('diagnose on a driftless random walk', () => {
  const rows = randomWalkRows(20_000, 3);
  const report = diagnose(rows, '1h', 0.16, 0);

  it('finds no direction: balanced hit rate near one half', () => {
    expect(report.overall.bh).toBeGreaterThan(0.46);
    expect(report.overall.bh).toBeLessThan(0.54);
  });

  it('touches +k ATR about twice as often as it finishes there, for calls and random entries alike', () => {
    const k1 = report.paths.find((p) => p.k === 1)!;
    expect(k1.callTouch / k1.callFinish).toBeGreaterThan(1.6);
    expect(k1.callTouch / k1.callFinish).toBeLessThan(2.6);
    expect(Math.abs(k1.callTouch - k1.randomTouch)).toBeLessThan(0.05);
  });

  it('returns one sign per category and a threshold that keeps the D0 call share', () => {
    expect(Object.keys(report.fit.signs).sort()).toEqual([...CATEGORIES].sort());
    const share = rows.filter((r) => r.tier !== 'neutral').length / rows.length;
    const d1 = rows.map((r) => d1Score(r.cats, report.fit.signs)).filter((v): v is number => v !== null);
    const d1Share = d1.filter((v) => Math.abs(v) > report.fit.threshold).length / d1.length;
    expect(d1Share).toBeCloseTo(share, 2);
  });
});

describe('d1Score', () => {
  it('averages only the present categories and is null when none is present', () => {
    const signs = Object.fromEntries(CATEGORIES.map((c) => [c, 1])) as Record<(typeof CATEGORIES)[number], 1 | -1>;
    expect(d1Score({ ...cats(null), trend: 40, momentum: -20 }, signs)).toBeCloseTo(10);
    expect(d1Score(cats(null), signs)).toBeNull();
    expect(d1Score({ ...cats(null), trend: 40 }, { ...signs, trend: -1 })).toBeCloseTo(-40);
  });
});

describe('volTopThresholds and conditionHolds', () => {
  const base = randomWalkRows(10, 1)[0];
  it('gives the two-thirds quantile per symbol and null for a symbol without volatility', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((v) => ({ ...base, vol20: v }));
    const none = { ...base, symbol: 'DOTUSDT', vol20: null };
    const t = volTopThresholds([...rows, none]);
    expect(t.BTCUSDT).toBeCloseTo(4.333, 2);
    expect(t.DOTUSDT).toBeNull();
    expect(conditionHolds('C2', { ...none }, 1, t)).toBe(false);
  });

  it('reads C1, C3 and C4 as the spec defines them', () => {
    expect(conditionHolds('C1', { ...base, cats: { ...base.cats, htf: 10 } }, 1, {})).toBe(true);
    expect(conditionHolds('C1', { ...base, cats: { ...base.cats, htf: null } }, 1, {})).toBe(false);
    expect(conditionHolds('C3', { ...base, score: 36 }, 1, {})).toBe(false);
    expect(conditionHolds('C3', { ...base, score: -36.5 }, -1, {})).toBe(true);
    expect(conditionHolds('C4', { ...base, hourUtc: 7 }, 1, {})).toBe(false);
    expect(conditionHolds('C4', { ...base, hourUtc: 8 }, 1, {})).toBe(true);
  });
});
