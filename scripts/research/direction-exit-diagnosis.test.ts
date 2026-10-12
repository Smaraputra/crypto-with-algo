// scripts/research/direction-exit-diagnosis.test.ts
import { describe, expect, it } from 'vitest';
import { seededRandom } from './carry-sim';
import { CATEGORIES, type DxRow } from './direction-exit-rows';
import { DIRECTION_EXIT_DEVELOP } from './direction-exit';
import { conditionHolds, d1Score, diagnose, parseArgs, validateDiagnosisRows, volTopThresholds } from './direction-exit-diagnosis';

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

describe('diagnose fit and lag details', () => {
  const rnd = seededRandom(7);
  const mk = (i: number, over: Partial<DxRow> = {}): DxRow => ({
    symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', t: i * HOUR, score: 30, tier: 'buy',
    cats: cats(1), vol20: rnd(), hourUtc: 10, atrPct: 1, fwd: 0, fwd1: 0, up: 0, down: 0, up1: 0, down1: 0, ...over,
  });

  it('measures the D1 call share among rows with a finite d1 score only', () => {
    const rows: DxRow[] = [];
    for (let i = 0; i < 400; i++) {
      const v = rnd() * 100 - 50;
      rows.push(mk(i, { score: i % 4 === 0 ? 30 : 0, tier: i % 4 === 0 ? 'buy' : 'neutral', cats: cats(v), fwd1: v }));
    }
    for (let i = 400; i < 800; i++) rows.push(mk(i, { cats: cats(null), fwd1: 0 }));
    const { fit } = diagnose(rows, '1h', 0.16, 1);
    const finite = rows.map((r) => d1Score(r.cats, fit.signs)).filter((x): x is number => x !== null);
    const d0Share = rows.slice(0, 400).filter((r) => r.tier !== 'neutral').length / 400;
    const d1Share = finite.filter((x) => Math.abs(x) > fit.threshold).length / finite.length;
    expect(d1Share).toBeCloseTo(d0Share, 2);
  });

  it('reports the achieved D1 call share next to D0 share, among finite-score rows and over all rows', () => {
    const rows: DxRow[] = [];
    for (let i = 0; i < 400; i++) {
      const v = rnd() * 100 - 50;
      rows.push(mk(i, { score: i % 4 === 0 ? 30 : 0, tier: i % 4 === 0 ? 'buy' : 'neutral', cats: cats(v), fwd1: v }));
    }
    for (let i = 400; i < 800; i++) rows.push(mk(i, { cats: cats(null), fwd1: 0 }));
    const { callShares, fit } = diagnose(rows, '1h', 0.16, 1);
    const finite = rows.map((r) => d1Score(r.cats, fit.signs)).filter((x): x is number => x !== null);
    expect(callShares.d0).toBeCloseTo(0.25, 10);
    expect(callShares.d0AllRows).toBeCloseTo(500 / 800, 10);
    expect(callShares.d1).toBe(finite.filter((x) => Math.abs(x) > fit.threshold).length / finite.length);
  });

  it('counts zero and missing category scores on calls apart from the signed ones', () => {
    const rows = [
      mk(0, { cats: { ...cats(null), trend: 5 } }),
      mk(1, { cats: { ...cats(null), trend: 0 } }),
      mk(2, { cats: { ...cats(null), trend: null } }),
      mk(3, { cats: { ...cats(null), trend: -2 } }),
      mk(4, { tier: 'neutral', score: 0, cats: { ...cats(null), trend: 0 } }),
    ];
    const trend = diagnose(rows, '1h', 0.16, 0).categories.find((c) => c.category === 'trend')!;
    expect(trend).toMatchObject({ n: 2, nZero: 1, nNull: 1, agreeShare: 0.5 });
  });

  it('throws instead of writing an infinite threshold when no d1 score is finite', () => {
    const rows = [0, 1, 2, 3].map((i) => mk(i, { cats: cats(null) }));
    expect(() => diagnose(rows, '1h', 0.16, 0)).toThrow(/finite D1/);
  });

  it('skips calls whose lag-1 path or outcome is not finite', () => {
    const good = (i: number) => mk(i, { fwd1: 2, up1: 3, down1: -1, vol20: 0.5 });
    const rows = [good(0), good(1), mk(2, { fwd1: 2, up1: null, down1: -1, vol20: 0.5 }), mk(3, { fwd1: NaN, up1: 3, down1: -1, vol20: 0.5 })];
    const k1 = diagnose(rows, '1h', 0.16, 1).paths.find((p) => p.k === 1)!;
    expect(k1.callTouch).toBe(1);
    expect(k1.callFinish).toBe(1);
  });

  it('uses the lag-1 fields at lag 1 and the lag-0 fields at lag 0', () => {
    const rows = Array.from({ length: 50 }, (_, i) => {
      const buy = i % 2 === 0;
      return mk(i, {
        tier: buy ? 'buy' : 'sell', score: buy ? 30 : -30,
        fwd: buy ? -2 : 2, up: 0.2, down: -0.2, fwd1: buy ? 2 : -2, up1: 3, down1: -3, vol20: 0.5,
      });
    });
    const l1 = diagnose(rows, '1h', 0.16, 1);
    const l0 = diagnose(rows, '1h', 0.16, 0);
    expect(l1.overall.bh).toBe(1);
    expect(l0.overall.bh).toBe(0);
    const p1 = l1.paths.find((p) => p.k === 1)!;
    expect(p1.callTouch).toBe(1);
    expect(p1.callFinish).toBe(1);
    expect(p1.randomTouch).toBe(1);
    const p0 = l0.paths.find((p) => p.k === 1)!;
    expect(p0.callTouch).toBe(0);
    expect(p0.callFinish).toBe(0);
    expect(l1.excursions.calls.mfePctMedian).toBe(3);
    expect(l1.excursions.calls.maeAtrMedian).toBe(-3);
    expect(l0.excursions.calls.mfePctMedian).toBeCloseTo(0.2);
  });

  it('reports MFE and MAE with the right sign per direction', () => {
    const buy = mk(0, { up: 4, down: -1, fwd: 1, atrPct: 2, vol20: 0.5 });
    const sell = mk(1, { tier: 'sell', score: -30, up: 4, down: -1, fwd: 1, atrPct: 2, vol20: 0.5 });
    const { calls } = diagnose([buy], '1h', 0.16, 0).excursions;
    expect(calls.mfePctMean).toBe(4);
    expect(calls.maePctMean).toBe(-1);
    expect(calls.mfeAtrMedian).toBe(2);
    const s = diagnose([sell], '1h', 0.16, 0).excursions.calls;
    expect(s.mfePctMean).toBe(1);
    expect(s.maePctMean).toBe(-4);
    expect(s.maeAtrMedian).toBe(-2);
  });

  it('keeps call and random median MFE close on a driftless walk', () => {
    const { calls, random } = diagnose(randomWalkRows(20_000, 3), '1h', 0.16, 0).excursions;
    expect(Math.abs(calls.mfePctMedian! / random.mfePctMedian! - 1)).toBeLessThan(0.1);
  });

  it('gives sign -1 to a category equal to minus fwd1 and +1 to one equal to fwd1', () => {
    const rows = Array.from({ length: 200 }, (_, i) => {
      const f = rnd() * 4 - 2;
      return mk(i, { fwd1: f, cats: { ...cats(null), trend: -f, momentum: f } });
    });
    const { signs } = diagnose(rows, '1h', 0.16, 1).fit;
    expect(signs.trend).toBe(-1);
    expect(signs.momentum).toBe(1);
  });

  it('ignores rows of other intervals', () => {
    const base = Array.from({ length: 30 }, (_, i) => mk(i));
    const other = Array.from({ length: 30 }, (_, i) => mk(100 + i, { interval: '4h' }));
    expect(diagnose([...base, ...other], '1h', 0.16, 0).calls).toBe(30);
    expect(diagnose(base, '1h', 0.16, 0).calls).toBe(30);
  });
});

describe('validateDiagnosisRows', () => {
  const start = Date.parse(DIRECTION_EXIT_DEVELOP.start);
  const end = Date.parse(DIRECTION_EXIT_DEVELOP.end);
  const row = (over: Partial<DxRow> = {}): DxRow => ({
    symbol: 'BTCUSDT', interval: '1h', style: 'day_trading', t: start, score: 30, tier: 'buy', cats: cats(1),
    vol20: 0.5, hourUtc: 0, atrPct: 1, fwd: 1, fwd1: 1, up: 1, down: -1, up1: 1, down1: -1, ...over,
  });

  it('accepts full rows of both cells whose horizon closes by the DEVELOP end', () => {
    const last1h = end + 1 - 25 * HOUR; // bar i + 24 closes at the DEVELOP end
    const last4h = end + 1 - 31 * 4 * HOUR;
    const rows = [row(), row({ t: last1h }), row({ interval: '4h', style: 'swing_trading', t: last4h })];
    expect(validateDiagnosisRows(rows)).toHaveLength(3);
  });

  it('fails loudly on a horizon past the DEVELOP end, a bar before its start, another interval or style', () => {
    expect(() => validateDiagnosisRows([row({ t: end + 1 - 24 * HOUR })])).toThrow(/horizon ends after/);
    expect(() => validateDiagnosisRows([row({ t: start - HOUR })])).toThrow(/before DEVELOP/);
    expect(() => validateDiagnosisRows([row({ interval: '15m' })])).toThrow(/interval/);
    expect(() => validateDiagnosisRows([row({ style: 'scalping' })])).toThrow(/style/);
  });

  it('fails on scores-only rows and on rows without a finite outcome', () => {
    const scoresOnly = { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading', candleTimestamp: start, score: 30, tier: 'buy' };
    expect(() => validateDiagnosisRows([scoresOnly])).toThrow(/full-mode/);
    expect(() => validateDiagnosisRows([JSON.parse(JSON.stringify(row({ fwd: Number.NaN })))])).toThrow(/fwd/);
  });
});

describe('parseArgs', () => {
  it('requires the expected manifest hash', () => {
    expect(() => parseArgs(['--rows', 'r', '--out', 'o'])).toThrow(/expect-manifest-hash/);
    expect(parseArgs(['--rows', 'r', '--out', 'o', '--expect-manifest-hash', 'h']).expectManifestHash).toBe('h');
  });
});
