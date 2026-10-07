import { describe, expect, it } from 'vitest';
import type { StrategyReport } from './report-schema';
import { computeGate8, formatGate8, harnessDailySeries, PHASE_TRIALS, type TrialSeries } from './legends-dsr';
import { expectedMaxSharpe } from '@/lib/stats/deflated-sharpe';

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

  it('computeGate8 and formatGate8 are pinned', async () => {
    const g = computeGate8(asHarness, others);
    await expect(stableStringify({ result: g, text: formatGate8(g) })).toMatchFileSnapshot('./__golden__/legends-gate8.json');
  });
});
