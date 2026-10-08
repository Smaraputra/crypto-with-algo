import { describe, expect, it } from 'vitest';
import type { StrategyReport } from './report-schema';
import {
  BROAD_GATE8,
  LEGENDS_GATE8,
  computeGate8,
  computeGate8Detailed,
  formatGate8,
  gate8FromStats,
  gate8Variance,
  harnessDailySeries,
  PHASE_TRIALS,
  PROGRAM_TRIALS,
  trialStats,
  type TrialSeries,
  type TrialStats,
} from './legends-dsr';
import { deflatedSharpe, expectedMaxSharpe, perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { normalCdf, normalQuantile } from '@/lib/stats/normal';

const DAY = 86_400_000;
const D0 = Date.UTC(2024, 0, 1);

function report(perSymbol: Array<{ symbol: string; start: number; trades: Array<[number, number]> }>): StrategyReport {
  return {
    family: 'nr7',
    fixedEvaluation: {
      perSymbol: Object.fromEntries(perSymbol.map((s) => [s.symbol, { evalStartTime: s.start }])),
    },
    perSymbol: perSymbol.map((s) => ({
      symbol: s.symbol,
      windows: [{ trades: s.trades.map(([exitTime, pnlPercent]) => ({ exitTime, pnlPercent })) }],
    })),
  } as unknown as StrategyReport;
}

describe('harnessDailySeries', () => {
  it('books trade returns on their exit day and averages over the symbols already evaluating', () => {
    const r = report([
      { symbol: 'A', start: D0, trades: [[D0 + 3_600_000, 2], [D0 + DAY + 5, -1], [D0 + DAY + 9, 3]] },
      { symbol: 'B', start: D0 + 2 * DAY, trades: [[D0 + 2 * DAY + 1, 4]] },
    ]);
    const { days, returns } = harnessDailySeries(r, D0 + 3 * DAY);
    expect(days).toEqual([D0, D0 + DAY, D0 + 2 * DAY, D0 + 3 * DAY]);
    // Day 0 and 1: only A live (0.02; -0.01 + 0.03); day 2: both live, (0 + 0.04) / 2; day 3: nothing.
    [0.02, 0.02, 0.02, 0].forEach((v, k) => expect(returns[k]).toBeCloseTo(v, 12));
  });
});

function series(id: string, mean: number, sd: number, n = 1500, seed = 1): TrialSeries {
  let s = seed;
  const next = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const returns = Array.from({ length: n }, () => {
    const u = Math.max(1e-12, next());
    const v = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  });
  return { id, kind: 'trend', days: returns.map((_, k) => D0 + k * DAY), returns };
}

describe('computeGate8', () => {
  const ids = ['TF1', 'TF2', 'TF3', 'TF4', 'C3', 'P1', 'P2', 'P3', 'P4', 'C1', 'C2'];
  const all = ids.map((id, k) => series(id, id === 'TF4' ? 0.004 : k % 2 ? 0.0005 : -0.0005, 0.02, 1500, k + 3));
  const others = Object.fromEntries(ids.map((id) => [id, { pass: true, consistency: null, note: '' }]));

  it('needs exactly the eleven trials', () => {
    expect(() => computeGate8(all.slice(0, 10), others)).toThrow(/all 11 trials/);
    expect(PHASE_TRIALS).toBe(11);
  });

  it('deflates every trial by the same expected maximum, built from the variance of all eleven', () => {
    const g = computeGate8(all, others);
    const tf4 = g.results.find((r) => r.id === 'TF4')!;
    // A daily Sharpe of 0.2 (about 3.8 a year) over 1,500 days clears the bar; the near-zero ones do not.
    expect(tf4.gate8).toBe(true);
    expect(tf4.verdict).toBe('pass (provisional)');
    expect(g.results.filter((r) => r.id !== 'TF4').every((r) => !r.gate8)).toBe(true);
    expect(g.expectedMaxAnnualSharpePhase).toBeCloseTo(expectedMaxSharpe(11, g.varianceOfPerPeriodSharpes) * Math.sqrt(365), 12);
    // The program count deflates harder.
    expect(tf4.dsrProgram).toBeLessThanOrEqual(tf4.dsrPhase);
  });

  it('fails a trial whose other gates or consistency fail, whatever gate 8 says', () => {
    const g = computeGate8(all, { ...others, TF4: { pass: false, consistency: null, note: 'x' } });
    expect(g.results.find((r) => r.id === 'TF4')!.verdict).toBe('fail');
    const h = computeGate8(all, { ...others, TF4: { pass: true, consistency: false, note: 'x' } });
    expect(h.results.find((r) => r.id === 'TF4')!.verdict).toBe('fail');

    // A harness trial with no consistency run cannot pass.
    const asHarness = all.map((t) => (t.id === 'TF4' ? { ...t, kind: 'harness' as const } : t));
    const missing = computeGate8(asHarness, { ...others, TF4: { pass: true, consistency: null, note: 'x' } });
    expect(missing.results.find((r) => r.id === 'TF4')!.verdict).toBe('fail');
    const agreed = computeGate8(asHarness, { ...others, TF4: { pass: true, consistency: true, note: 'x' } });
    expect(agreed.results.find((r) => r.id === 'TF4')!.verdict).toBe('pass (provisional)');
  });
});

/** JSON with object keys sorted recursively; numbers go through JSON so doubles round-trip exactly. */
function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 1) + '\n';
}

describe('golden: the default gate 8 path', () => {
  // Pinned against the unparameterised legends-dsr.ts: a later change to the defaults must fail here.
  const ids = ['TF1', 'TF2', 'TF3', 'TF4', 'C3', 'P1', 'P2', 'P3', 'P4', 'C1', 'C2'];
  const all = ids.map((id, k) =>
    series(id, [0.001, -0.0004, 0.0007, 0.003, 0.0025, 0.0002, 0.0009, -0.002, -0.0015, 0.0011, 0.0004][k], 0.02 + k * 0.001, 1200 + k * 37, k + 11)
  );
  const others = Object.fromEntries(
    ids.map((id, k) => [id, { pass: k % 3 !== 1, consistency: k < 5 ? null : k % 2 === 0, note: `n${k}` }])
  );
  const asHarness = all.map((s, k) => (k >= 5 ? { ...s, kind: 'harness' as const } : s));

  // Twelve significant digits: the last one or two bits of skewness differ between Node 20 (CI) and Node 24,
  // which says nothing about the gate 8 path this pins.
  const significant = (v: unknown): unknown =>
    typeof v === 'number'
      ? Number.isFinite(v)
        ? Number(v.toPrecision(12))
        : v
      : Array.isArray(v)
        ? v.map(significant)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, significant(x)]))
          : v;

  it('computeGate8 and formatGate8 are pinned', async () => {
    const g = computeGate8(asHarness, others);
    await expect(stableStringify({ result: significant(g), text: formatGate8(g) })).toMatchFileSnapshot(
      './__golden__/legends-gate8.json'
    );
  });

  it('explicit legends options give the same result as the defaults', () => {
    expect(computeGate8(asHarness, others, LEGENDS_GATE8)).toEqual(computeGate8(asHarness, others));
    expect(formatGate8(computeGate8(asHarness, others), LEGENDS_GATE8)).toBe(formatGate8(computeGate8(asHarness, others)));
    expect(LEGENDS_GATE8).toEqual({ trialIds: null, numTrials: 11, programTrials: 1724, varianceMode: 'cross-trial' });
  });
});

/*
 * The legends gate 8 of record (trend-sim.ts header, RESULT, HARNESS RULES AND GATE 8): each trial's
 * statistics as the unmodified legends-dsr.ts computed them on 2026-10-07 from the eleven VPS reports
 * ($HOME/legends-out/trend-*.json and patterns/strategy-*.json, export d84b32d9fb31), reproducing the
 * printed record (variance 2.405e-3, expected max 1.520 at N = 11, C3 0.330, TF4 0.294).
 */
const RECORD: Array<TrialStats & { dsrPhase: number; dsrProgram: number; otherGates: boolean; consistency: boolean | null }> = [
  { id: 'TF1', kind: 'trend', n: 2485, perPeriodSharpe: 0.047519499502377036, skewness: 0.2715200749572153, kurtosis: 9.303711251215992, dsrPhase: 0.05445198743733587, dsrProgram: 1.0933467793331006e-9, otherGates: true, consistency: null },
  { id: 'TF2', kind: 'trend', n: 2485, perPeriodSharpe: 0.012075700096132307, skewness: 1.9691763370995174, kurtosis: 53.91746989573896, dsrPhase: 0.00033643035419058184, dsrProgram: 2.8371632961941515e-15, otherGates: false, consistency: null },
  { id: 'TF3', kind: 'trend', n: 2485, perPeriodSharpe: 0.04319963134056054, skewness: 2.044168643120104, kurtosis: 65.81522675490551, dsrPhase: 0.030960973553544116, dsrProgram: 9.994376896361728e-11, otherGates: false, consistency: null },
  { id: 'TF4', kind: 'trend', n: 2485, perPeriodSharpe: 0.06871082524522056, skewness: 0.3159079730120397, kurtosis: 13.24422498138178, dsrPhase: 0.2937917431527828, dsrProgram: 4.318877470165718e-7, otherGates: true, consistency: null },
  { id: 'C3', kind: 'trend', n: 2485, perPeriodSharpe: 0.07098115882669785, skewness: 1.111352848117776, kurtosis: 19.34363827592585, dsrPhase: 0.3300933408118274, dsrProgram: 4.137233934413552e-7, otherGates: true, consistency: null },
  { id: 'P1', kind: 'harness', n: 2401, perPeriodSharpe: 0.024640943560213322, skewness: 47.31261144093636, kurtosis: 2284.877314852716, dsrPhase: 1.2600194719038919e-10, dsrProgram: 8.351166869003139e-61, otherGates: false, consistency: true },
  { id: 'P2', kind: 'harness', n: 2401, perPeriodSharpe: 0.04268863184016106, skewness: 6.664871459123218, kurtosis: 104.67012288165377, dsrPhase: 0.019324416357747752, dsrProgram: 1.5022479734904408e-12, otherGates: false, consistency: true },
  { id: 'P3', kind: 'harness', n: 2401, perPeriodSharpe: 0.040245003040031944, skewness: 17.64649443256969, kurtosis: 460.6137224681829, dsrPhase: 0.0026241999926816203, dsrProgram: 1.0621682698631343e-19, otherGates: false, consistency: true },
  { id: 'P4', kind: 'harness', n: 2401, perPeriodSharpe: -0.07611979441289221, skewness: 0.17830953915882997, kurtosis: 73.40962399503182, dsrPhase: 2.7730163679539234e-13, dsrProgram: 9.710528313698607e-30, otherGates: false, consistency: true },
  { id: 'C1', kind: 'harness', n: 1713, perPeriodSharpe: -0.06254249428678814, skewness: 2.0296128509013056, kurtosis: 12.2791192718804, dsrPhase: 1.7792589884257333e-8, dsrProgram: 2.639803457980878e-19, otherGates: false, consistency: true },
  { id: 'C2', kind: 'harness', n: 2485, perPeriodSharpe: 0.04955013391970715, skewness: 21.65197502085175, kurtosis: 718.3557506205808, dsrPhase: 0.0068162382964994115, dsrProgram: 2.1678570212374756e-22, otherGates: false, consistency: true },
];

describe('the recorded legends gate 8, from the record\'s own trial statistics', () => {
  const stats: TrialStats[] = RECORD.map(({ id, kind, n, perPeriodSharpe: s, skewness, kurtosis }) => ({ id, kind, n, perPeriodSharpe: s, skewness, kurtosis }));
  const other = Object.fromEntries(RECORD.map((r) => [r.id, { pass: r.otherGates, consistency: r.consistency, note: '' }]));
  const { result, variance } = gate8FromStats(stats, other);

  it('reproduces the cross-trial variance and the expected maxima exactly', () => {
    expect(result.trials).toBe(11);
    expect(result.varianceOfPerPeriodSharpes).toBe(0.002404938448984765);
    expect(result.varianceOfPerPeriodSharpes.toExponential(3)).toBe('2.405e-3');
    expect(result.expectedMaxAnnualSharpePhase).toBe(1.5198576216660418);
    expect(result.expectedMaxAnnualSharpePhase.toFixed(3)).toBe('1.520');
    expect(result.expectedMaxAnnualSharpeProgram).toBe(3.1919833725542577);
    expect(variance).toEqual({ mode: 'cross-trial', crossTrial: result.varianceOfPerPeriodSharpes, floor: null, floorObservations: null, used: result.varianceOfPerPeriodSharpes });
  });

  it('reproduces every trial\'s deflated Sharpe probability exactly, C3 0.330 and TF4 0.294 among them', () => {
    for (const r of RECORD) {
      const got = result.results.find((x) => x.id === r.id)!;
      expect(got.dsrPhase).toBe(r.dsrPhase);
      expect(got.dsrProgram).toBe(r.dsrProgram);
      expect(got.verdict).toBe('fail');
    }
    const at = (id: string) => result.results.find((x) => x.id === id)!;
    expect(at('C3').dsrPhase.toFixed(3)).toBe('0.330');
    expect(at('TF4').dsrPhase.toFixed(3)).toBe('0.294');
    expect(at('TF1').dsrPhase.toFixed(3)).toBe('0.054');
    expect(at('C3').annualSharpe.toFixed(2)).toBe('1.36');
    expect(formatGate8(result).split('\n')[0]).toBe(
      'gate 8 across 11 trials: variance of per-period Sharpes 2.405e-3, expected max annual Sharpe 1.520 at N = 11, 3.192 at N = 1724'
    );
  });

  it('PROGRAM_TRIALS and PHASE_TRIALS are the legends counts', () => {
    expect([PHASE_TRIALS, PROGRAM_TRIALS]).toEqual([11, 1724]);
  });
});

/** n alternating returns mean +- dev: per-period Sharpe exactly mean / (dev x sqrt(n / (n - 1))), skewness 0, kurtosis 1. */
function twoPoint(id: string, mean: number, dev: number, n: number): TrialSeries {
  const returns = Array.from({ length: n }, (_, k) => (k % 2 === 0 ? mean + dev : mean - dev));
  return { id, kind: 'trend', days: returns.map((_, k) => D0 + k * DAY), returns };
}

describe('gate 8 options (the broad phase)', () => {
  const ids = ['TF1', 'TF2', 'TF3', 'TF4', 'C3'];
  const pass = Object.fromEntries(ids.map((id) => [id, { pass: true, consistency: null, note: '' }]));

  it('gate8Variance: cross-trial is the sample variance; max-cross-sampling takes the larger of it and 1 / (T - 1)', () => {
    const sharpes = [0.01, 0.02, 0.03];
    const cross = gate8Variance(sharpes, 'cross-trial', null);
    expect(cross.used).toBeCloseTo(1e-4, 15);
    expect(cross.floor).toBeNull();
    const floored = gate8Variance(sharpes, 'max-cross-sampling', 1001);
    expect(floored.floor).toBe(1 / 1000);
    expect(floored.used).toBe(1 / 1000);
    expect(floored.crossTrial).toBeCloseTo(1e-4, 15);
    const wide = gate8Variance([0.1, -0.1, 0.2], 'max-cross-sampling', 1001);
    expect(wide.used).toBe(wide.crossTrial);
    expect(() => gate8Variance(sharpes, 'max-cross-sampling', 1)).toThrow(/T >= 2/);
  });

  it('BROAD_GATE8 is N = 16, program 1,729, the floor mode and the five broad trials', () => {
    expect(BROAD_GATE8).toEqual({
      trialIds: ['TF1', 'TF2', 'TF3', 'TF4', 'C3'],
      numTrials: 16,
      programTrials: 1729,
      varianceMode: 'max-cross-sampling',
    });
  });

  it('uses the floor at T = the shortest series when the five Sharpes spread less than the sampling error', () => {
    // Per-period Sharpes about 0.05 to 0.07 (spread far below 1 / (T - 1) at T = 1,000).
    const series = ids.map((id, k) => twoPoint(id, 0.001 * (5 + k * 0.5), 0.1, 1000 + 200 * k));
    const { result, variance } = computeGate8Detailed(series, pass, BROAD_GATE8);
    expect(variance.floorObservations).toBe(1000);
    expect(variance.floor).toBe(1 / 999);
    expect(variance.crossTrial).toBeLessThan(variance.floor!);
    expect(result.varianceOfPerPeriodSharpes).toBe(1 / 999);
    expect(result.trials).toBe(16);
    expect(result.expectedMaxAnnualSharpePhase).toBe(expectedMaxSharpe(16, 1 / 999) * Math.sqrt(365));
    expect(result.expectedMaxAnnualSharpeProgram).toBe(expectedMaxSharpe(1729, 1 / 999) * Math.sqrt(365));
    // Each trial with its own length and moments (two-point series: skewness 0, kurtosis 1).
    for (const s of series) {
      const r = result.results.find((x) => x.id === s.id)!;
      const sr = perPeriodSharpe(s.returns);
      expect(r.perPeriodSharpe).toBe(sr);
      expect(r.skewness).toBeCloseTo(0, 12);
      expect(r.kurtosis).toBeCloseTo(1, 12);
      expect(r.dsrPhase).toBe(
        deflatedSharpe({ observedSharpe: sr, numTrials: 16, varianceOfTrialSharpes: 1 / 999, nObservations: s.returns.length, skewness: r.skewness, kurtosis: r.kurtosis }).probability
      );
    }
    // A hand computation for TF1: SR = 0.005 / (0.1 x sqrt(1000 / 999)), SR* = sqrt(1/999) x the expected max z at
    // N = 16, and with skewness 0 and kurtosis 1 the PSR radicand is 1, so DSR = Phi((SR - SR*) x sqrt(999)).
    const tf1 = result.results.find((x) => x.id === 'TF1')!;
    const sr = 0.005 / (0.1 * Math.sqrt(1000 / 999));
    expect(tf1.perPeriodSharpe).toBeCloseTo(sr, 12);
    const g = 0.5772156649;
    const srStar = Math.sqrt(1 / 999) * ((1 - g) * normalQuantile(1 - 1 / 16) + g * normalQuantile(1 - 1 / (16 * Math.E)));
    expect(tf1.dsrPhase).toBeCloseTo(normalCdf((sr - srStar) * Math.sqrt(999)), 9);
    // The header POWER statement: the expected maximum at N = 16 is about 1.80 sampling standard errors.
    expect(srStar / Math.sqrt(1 / 999)).toBeCloseTo(1.8, 2);
    expect(formatGate8(result, BROAD_GATE8).split('\n')[0]).toMatch(/at N = 16, .* at N = 1729$/);
  });

  it('uses the cross-trial variance when it is larger, and an explicit T for the floor', () => {
    const series = ids.map((id, k) => twoPoint(id, 0.004 * (k - 2), 0.02, 1500));
    const { result, variance } = computeGate8Detailed(series, pass, BROAD_GATE8);
    expect(variance.crossTrial).toBeGreaterThan(variance.floor!);
    expect(result.varianceOfPerPeriodSharpes).toBe(variance.crossTrial);
    const explicit = computeGate8Detailed(series, pass, { ...BROAD_GATE8, floorObservations: 11 });
    expect(explicit.variance.floor).toBe(0.1);
    expect(explicit.result.varianceOfPerPeriodSharpes).toBe(0.1);
  });

  it('refuses any trial set but the named one, and a wrong count under the legends default', () => {
    const series = ids.map((id) => twoPoint(id, 0.001, 0.02, 100));
    expect(() => computeGate8Detailed(series.slice(0, 4), pass, BROAD_GATE8)).toThrow(/the trials C3,TF1,TF2,TF3,TF4; got TF1,TF2,TF3,TF4/);
    expect(() => computeGate8Detailed([...series.slice(0, 4), { ...series[0] }], pass, BROAD_GATE8)).toThrow(/got TF1,TF1/);
    expect(() => computeGate8(series, pass)).toThrow(/all 11 trials; got 5/);
  });

  it('trialStats reads the series length, Sharpe and moments', () => {
    const s = twoPoint('TF1', 0.001, 0.01, 10);
    expect(trialStats(s)).toEqual({ id: 'TF1', kind: 'trend', n: 10, perPeriodSharpe: perPeriodSharpe(s.returns), skewness: expect.any(Number), kurtosis: expect.any(Number) });
  });
});
