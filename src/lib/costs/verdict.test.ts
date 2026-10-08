import { describe, expect, it } from 'vitest';
import {
  COST_TONE_LABEL,
  DOMINANT_WIN_RATE,
  MATERIAL_WIN_RATE,
  MIN_INDEPENDENT_WINDOWS,
  allBarsHitRate,
  costTone,
  costVerdict,
  tailHitRate,
} from './verdict';

describe('hit rates implied by the program measured ICs', () => {
  it('converts IC 0.02 and 0.05 over every bar', () => {
    expect(allBarsHitRate(0.02)).toBeCloseTo(0.50637, 5);
    expect(allBarsHitRate(0.05)).toBeCloseTo(0.51592, 5);
  });

  it('converts IC 0.02 and 0.05 on tail trades at |z| = 2', () => {
    expect(tailHitRate(0.02)).toBeCloseTo(0.51595, 5);
    expect(tailHitRate(0.05)).toBeCloseTo(0.53983, 5);
  });

  it('places the cut-offs just above what those signals deliver', () => {
    expect(MATERIAL_WIN_RATE).toBeGreaterThan(allBarsHitRate(0.05));
    expect(DOMINANT_WIN_RATE).toBeGreaterThan(tailHitRate(0.05));
  });
});

describe('costTone', () => {
  it('grades the required win rate', () => {
    expect(costTone({ kind: 'possible', winRate: 0.51 })).toBe('small');
    expect(costTone({ kind: 'possible', winRate: 0.52 })).toBe('small');
    expect(costTone({ kind: 'possible', winRate: 0.53 })).toBe('material');
    expect(costTone({ kind: 'possible', winRate: 0.55 })).toBe('material');
    expect(costTone({ kind: 'possible', winRate: 0.68 })).toBe('dominate');
    expect(costTone({ kind: 'impossible' })).toBe('exceed');
  });

  it('labels every tone in words, never only by colour', () => {
    expect(COST_TONE_LABEL.dominate).toBe('Costs dominate');
    expect(Object.keys(COST_TONE_LABEL)).toHaveLength(4);
  });
});

describe('costVerdict', () => {
  it('withholds a verdict when the move rests on too few independent windows', () => {
    expect(costVerdict({ kind: 'possible', winRate: 0.6 }, MIN_INDEPENDENT_WINDOWS - 1)).toBeNull();
    expect(costVerdict({ kind: 'possible', winRate: 0.6 }, MIN_INDEPENDENT_WINDOWS)).toBe('dominate');
  });
});
