import { describe, expect, it } from 'vitest';
import { compareToReference, componentParity } from './direction-exit-repro';

const row = (t: number, score: number, tier = score > 28 ? 'buy' : 'neutral') => ({ symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading', candleTimestamp: t, score, tier });
const win = { start: 0, end: 1e12 };

describe('compareToReference', () => {
  it('passes when every reference bar is matched with the same tier and score', () => {
    const ref = Array.from({ length: 200 }, (_, i) => row(i, (i % 50) - 10));
    const r = compareToReference(ref, ref, '1h', win);
    expect(r).toMatchObject({ referenceRows: 200, matched: 200, sameTierShare: 1, pass: true });
  });

  it('fails when too few reference bars are matched', () => {
    const ref = Array.from({ length: 200 }, (_, i) => row(i, (i % 50) - 10));
    const r = compareToReference(ref.slice(0, 150), ref, '1h', win);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toContain('matched');
  });

  it('fails when tiers disagree on more than 1% of bars', () => {
    const ref = Array.from({ length: 200 }, (_, i) => row(i, (i % 50) - 10));
    const mine = ref.map((r, i) => (i < 5 ? { ...r, tier: 'sell' } : r));
    expect(compareToReference(mine, ref, '1h', win).pass).toBe(false);
  });

  it('ignores a reference row of another trading style', () => {
    const ref = [row(1, 30), { ...row(2, 30), tradingStyle: 'scalping' }];
    expect(compareToReference([row(1, 30)], ref, '1h', win).referenceRows).toBe(1);
  });

  it('fails on correlation when tiers agree but scores are uncorrelated', () => {
    const mine = Array.from({ length: 300 }, (_, i) => row(i, i % 7, 'neutral'));
    const ref = Array.from({ length: 300 }, (_, i) => row(i, (i * 13) % 11, 'neutral'));
    const r = compareToReference(mine, ref, '1h', win);
    expect(r.sameTierShare).toBe(1);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toContain('correlation');
  });

  it('ignores other intervals, styles and bars outside the window', () => {
    const ref = [row(1, 30), { ...row(2, 30), interval: '4h' }, row(5_000, 30)];
    const r = compareToReference([row(1, 30)], ref, '1h', { start: 0, end: 1_000 });
    expect(r.referenceRows).toBe(1);
  });
});

describe('componentParity', () => {
  it('passes on equal values and fails on a difference', () => {
    const a = { trend: Float64Array.from({ length: 1500 }, (_, i) => i % 40) };
    expect(componentParity(a, a).pass).toBe(true);
    const b = { trend: Float64Array.from(a.trend, (v, i) => (i === 7 ? v + 1 : v)) };
    expect(componentParity(a, b)).toMatchObject({ pass: false, maxAbsDiff: 1 });
  });

  it('fails when a value is finite on one side and NaN on the other', () => {
    const a = { trend: Float64Array.from({ length: 1500 }, (_, i) => i % 40) };
    const b = { trend: Float64Array.from(a.trend, (v, i) => (i === 3 ? NaN : v)) };
    expect(componentParity(a, b)).toMatchObject({ pass: false, oneSided: 1, maxAbsDiff: 0 });
    expect(componentParity(a, a)).toMatchObject({ pass: true, oneSided: 0 });
  });

  it('needs at least 1,000 compared values', () => {
    const a = { trend: Float64Array.from({ length: 10 }, () => 1) };
    expect(componentParity(a, a).pass).toBe(false);
  });
});
