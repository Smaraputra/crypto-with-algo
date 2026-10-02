import { describe, expect, it } from 'vitest';
import { evaluateTrendGates, trendVerdict, type TrendGateInputs } from './trend-gates';

const passing: TrendGateInputs = {
  sampleDays: 2485,
  sharpeCiLow: 0.1,
  alphaCiLow: 0.01,
  timingP: 0.01,
  dropOneAlphas: { BTCUSDT: 0.02, ETHUSDT: 0.03 },
  yearAlphas: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year) => ({ year, alpha: 0.01 })),
  stressAlpha: 0.01,
  consistencyAlpha: 0.01,
};

describe('evaluateTrendGates', () => {
  it('lists the nine pre-registered gates in order, gate 8 pending', () => {
    const gates = evaluateTrendGates(passing);
    expect(gates.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(gates.find((g) => g.id === 8)!.pass).toBeNull();
    expect(gates.filter((g) => g.id !== 8).every((g) => g.pass === true)).toBe(true);
    expect(trendVerdict(gates)).toBe('pending-trials');
  });

  it('fails a short sample, a CI touching zero, timing at 0.05, one negative drop and the stress', () => {
    const gates = evaluateTrendGates({
      ...passing,
      sampleDays: 5 * 365 - 1,
      sharpeCiLow: 0,
      timingP: 0.05,
      dropOneAlphas: { BTCUSDT: 0.02, ETHUSDT: -0.001 },
      stressAlpha: 0,
    });
    const failed = gates.filter((g) => g.pass === false).map((g) => g.name);
    expect(failed).toEqual(['sample', 'expectancy', 'timing', 'symbols', 'stress']);
    expect(gates.find((g) => g.name === 'symbols')!.note).toContain('ETHUSDT');
    expect(trendVerdict(gates)).toBe('fail');
  });

  it('counts only 2020 to 2025 for the year gate and needs 60%', () => {
    const years = (positive: number[]) =>
      [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year) => ({
        year,
        alpha: positive.includes(year) ? 0.01 : -0.01,
      }));
    const four = evaluateTrendGates({ ...passing, yearAlphas: years([2020, 2021, 2022, 2023]) });
    expect(four.find((g) => g.name === 'years')!.pass).toBe(true);
    const threePlusPartials = evaluateTrendGates({ ...passing, yearAlphas: years([2019, 2020, 2021, 2022, 2026]) });
    expect(threePlusPartials.find((g) => g.name === 'years')!.pass).toBe(false);
    expect(threePlusPartials.find((g) => g.name === 'years')!.value).toBeCloseTo(0.5, 12);
  });

  it('reads an undefined statistic as a failure, never a pass', () => {
    const gates = evaluateTrendGates({ ...passing, alphaCiLow: Number.NaN, consistencyAlpha: Number.NaN });
    expect(gates.find((g) => g.name === 'twin')!.pass).toBe(false);
    expect(gates.find((g) => g.name === 'twin')!.value).toBeNull();
    expect(gates.find((g) => g.name === 'consistency')!.pass).toBe(false);
  });
});
