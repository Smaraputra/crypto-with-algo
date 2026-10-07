// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AFTER_PAPER_FROM,
  AFTER_PAPER_TO,
  FLOW_BLOCK_DAYS,
  FLOW_BOOT_DRAWS,
  FLOW_BOOT_SEED,
  FLOW_GATED_YEARS,
  FLOW_MIN_SAMPLE_DAYS,
  FLOW_NULL_DRAWS,
  FLOW_NULL_SEED,
  FLOW_PHASE_TRIALS,
  FLOW_PROGRAM_TRIALS,
  PAPER_OVERLAP_FROM,
  PAPER_OVERLAP_TO,
  evaluateFlowGates,
  flowVerdict,
  meanOf,
  windowStats,
  yearStats,
  type FlowGateInputs,
} from './broad-flow-gates';
import { DAY_MS } from './trend-signals';
import { annualisedSharpe } from './trend-sim';

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe('pre-registered constants (broad-flow.ts header, GATES)', () => {
  it('pins the header\'s numbers', () => {
    expect(FLOW_PHASE_TRIALS).toBe(3);
    expect(FLOW_PROGRAM_TRIALS).toBe(1732);
    expect(FLOW_MIN_SAMPLE_DAYS).toBe(1825);
    expect([FLOW_BLOCK_DAYS, FLOW_BOOT_DRAWS, FLOW_BOOT_SEED]).toEqual([60, 2000, 42]);
    expect([FLOW_NULL_DRAWS, FLOW_NULL_SEED]).toEqual([200, 7]);
    expect([...FLOW_GATED_YEARS]).toEqual([2021, 2022, 2023, 2024, 2025]);
    expect([AFTER_PAPER_FROM, AFTER_PAPER_TO]).toEqual([utc(2022, 7, 1), utc(2026, 7, 1)]);
    expect([PAPER_OVERLAP_FROM, PAPER_OVERLAP_TO]).toEqual([utc(2021, 3, 1), utc(2022, 7, 1)]);
  });
});

describe('window statistics', () => {
  const days = Array.from({ length: 10 }, (_, k) => utc(2021, 12, 27) + k * DAY_MS);
  const returns = [1, -2, 3, 4, -5, 6, 7, -8, 9, 10].map((x) => x / 1000);

  it('mean and Sharpe over [from, to); NaN without days', () => {
    const w = windowStats(days, returns, utc(2022, 1, 1), utc(2022, 1, 4));
    expect(w.days).toBe(3);
    expect(w.mean).toBeCloseTo((6 + 7 - 8) / 3000, 15);
    expect(w.sharpe).toBe(annualisedSharpe([0.006, 0.007, -0.008]));
    expect(windowStats(days, returns, utc(2023, 1, 1), utc(2024, 1, 1))).toEqual({ days: 0, mean: Number.NaN, sharpe: Number.NaN });
    expect(meanOf([])).toBeNaN();
  });

  it('calendar years split at 1 January', () => {
    const years = yearStats(days, returns, [2021, 2022]);
    expect(years.map((y) => [y.year, y.days])).toEqual([
      [2021, 5],
      [2022, 5],
    ]);
    // 2021-12-27 to 2021-12-31: (1 - 2 + 3 + 4 - 5) / 5, in thousandths.
    expect(years[0].mean).toBeCloseTo(1 / 5000, 15);
    expect(years[1].mean).toBeCloseTo(24 / 5000, 15);
  });
});

describe('evaluateFlowGates', () => {
  const passing: FlowGateInputs = {
    sampleDays: 1948,
    sharpeCiLow: 0.1,
    permutedP: 0.01,
    alignedP: 0.02,
    drops: [
      { label: '2020', mean: 0.001 },
      { label: 'legends ten', mean: 0.002 },
      { label: 'BTC and ETH', mean: 0.001 },
      { label: 'top five', mean: 0.0005 },
    ],
    yearMeans: [
      { year: 2021, mean: 0.001 },
      { year: 2022, mean: -0.001 },
      { year: 2023, mean: 0.001 },
      { year: 2024, mean: -0.002 },
      { year: 2025, mean: 0.001 },
      { year: 2026, mean: -0.01 },
    ],
    stressMean: 0.0004,
    afterPaperMean: 0.0002,
    control: false,
  };
  const gate = (x: FlowGateInputs, name: string) => evaluateFlowGates(x).find((g) => g.name === name)!;

  it('eight gates in the header\'s order; all decided gates pass, gate 7 pending: pending-trials', () => {
    const gates = evaluateFlowGates(passing);
    expect(gates.map((g) => [g.id, g.name])).toEqual([
      [1, 'sample'],
      [2, 'expectancy'],
      [3, 'timing'],
      [4, 'cohorts'],
      [5, 'years'],
      [6, 'stress'],
      [7, 'trials'],
      [8, 'after-paper'],
    ]);
    expect(gates.filter((g) => g.pass === null).map((g) => g.id)).toEqual([7]);
    expect(gates.every((g) => g.pass !== false)).toBe(true);
    expect(flowVerdict(gates, false)).toBe('pending-trials');
    // Three of five gated years positive is 60%: a pass; 2026 is not counted.
    expect(gate(passing, 'years')).toMatchObject({ pass: true, value: 0.6 });
  });

  it('gate 1 needs 1,825 days; gate 2 a CI low above 0', () => {
    expect(gate({ ...passing, sampleDays: 1824 }, 'sample').pass).toBe(false);
    expect(gate({ ...passing, sampleDays: 1825 }, 'sample').pass).toBe(true);
    expect(gate({ ...passing, sharpeCiLow: 0 }, 'expectancy').pass).toBe(false);
    expect(gate({ ...passing, sharpeCiLow: Number.NaN }, 'expectancy')).toMatchObject({ pass: false, value: null });
  });

  it('gate 3: the larger p gates, both must be under 0.05; a null that did not run fails', () => {
    expect(gate(passing, 'timing')).toMatchObject({ pass: true, value: 0.02 });
    expect(gate({ ...passing, alignedP: 0.05 }, 'timing').pass).toBe(false);
    expect(gate({ ...passing, permutedP: 0.2 }, 'timing')).toMatchObject({ pass: false, value: 0.2 });
    expect(gate({ ...passing, alignedP: null }, 'timing')).toMatchObject({ pass: false, value: null });
    expect(gate({ ...passing, alignedP: null }, 'timing').note).toMatch(/aligned \(not run\)/);
  });

  it('gate 4: every drop\'s mean above 0; none given fails', () => {
    const one = { ...passing, drops: [...passing.drops, { label: 'top five', mean: 0 }] };
    expect(gate(one, 'cohorts')).toMatchObject({ pass: false, value: 4, threshold: 5 });
    expect(gate(one, 'cohorts').note).toMatch(/not positive without: top five/);
    expect(gate({ ...passing, drops: [{ label: '2021', mean: Number.NaN }] }, 'cohorts').pass).toBe(false);
    expect(gate({ ...passing, drops: [] }, 'cohorts').pass).toBe(false);
  });

  it('gate 5: under 60% of 2021 to 2025 fails; a missing year counts as not positive', () => {
    const two = passing.yearMeans.map((y) => (y.year === 2025 ? { ...y, mean: -0.001 } : y));
    expect(gate({ ...passing, yearMeans: two }, 'years')).toMatchObject({ pass: false, value: 0.4 });
    const missing = passing.yearMeans.filter((y) => y.year !== 2021);
    expect(gate({ ...passing, yearMeans: missing }, 'years').pass).toBe(false);
  });

  it('gates 6 and 8: means above 0', () => {
    expect(gate({ ...passing, stressMean: 0 }, 'stress').pass).toBe(false);
    expect(gate({ ...passing, afterPaperMean: -1e-6 }, 'after-paper').pass).toBe(false);
    expect(flowVerdict(evaluateFlowGates({ ...passing, afterPaperMean: -1e-6 }), false)).toBe('fail');
  });

  it('the control D: gate 7 does not apply and the verdict is control whatever the gates', () => {
    const gates = evaluateFlowGates({ ...passing, control: true, sharpeCiLow: -1 });
    expect(gates[6]).toMatchObject({ pass: null });
    expect(gates[6].note).toMatch(/not a trial/);
    expect(flowVerdict(gates, true)).toBe('control');
  });
});
