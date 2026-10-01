// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SAVINGS_HURDLE_ANNUAL, evaluateCarryRule, evaluateR1Timing } from './carry-gates';

const periods = (values: number[]) =>
  ['2023', '2024', '2025', '2026H1'].map((label, i) => ({ label, annual: values[i] }));

describe('evaluateCarryRule', () => {
  it('passes only a significant result above the hurdle with at most one negative period', () => {
    const v = evaluateCarryRule({ annual: 0.08, ciLow: 0.02, ciHigh: 0.14, days: 1277 }, periods([0.1, 0.09, -0.01, 0.07]));
    expect(v.killed).toBe(false);
    expect(v.gates.every((g) => g.pass)).toBe(true);
  });
  it('fires on a CI that reaches zero', () => {
    const v = evaluateCarryRule({ annual: 0.08, ciLow: -0.001, ciHigh: 0.16, days: 1277 }, periods([0.1, 0.1, 0.1, 0.1]));
    expect(v.killed).toBe(true);
    expect(v.gates.find((g) => g.name === 'significance')!.pass).toBe(false);
  });
  it('fires on a significant result below the stated savings hurdle', () => {
    const v = evaluateCarryRule({ annual: 0.03, ciLow: 0.01, ciHigh: 0.05, days: 1277 }, periods([0.03, 0.03, 0.03, 0.03]));
    expect(SAVINGS_HURDLE_ANNUAL).toBe(0.05);
    expect(v.killed).toBe(true);
    expect(v.gates.find((g) => g.name === 'hurdle')!.pass).toBe(false);
  });
  it('fires on two negative calendar periods and names them', () => {
    const v = evaluateCarryRule({ annual: 0.08, ciLow: 0.01, ciHigh: 0.15, days: 1277 }, periods([0.2, -0.01, -0.02, 0.1]));
    const g = v.gates.find((x) => x.name === 'periods')!;
    expect(g.pass).toBe(false);
    expect(g.note).toContain('2024');
    expect(g.note).toContain('2025');
  });
});

describe('evaluateR1Timing', () => {
  it('needs both a positive difference over R0 and p below 0.05', () => {
    expect(evaluateR1Timing({ annual: 0.02, ciLow: 0.001, ciHigh: 0.04, days: 1277 }, 0.01).isTimingFinding).toBe(true);
    expect(evaluateR1Timing({ annual: 0.02, ciLow: -0.001, ciHigh: 0.04, days: 1277 }, 0.01).isTimingFinding).toBe(false);
    expect(evaluateR1Timing({ annual: 0.02, ciLow: 0.001, ciHigh: 0.04, days: 1277 }, 0.2).isTimingFinding).toBe(false);
  });
});
