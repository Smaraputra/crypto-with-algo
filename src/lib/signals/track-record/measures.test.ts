import { describe, expect, it } from 'vitest';

import {
  directionOf,
  monthMeasures,
  monthOf,
  outcomeOf,
  pointMeasures,
  tierCode,
  tierFromCode,
} from './measures';

const row = (tier: string, forwardReturnPercent: number) => ({ tier, forwardReturnPercent });

describe('directionOf', () => {
  it('maps buy tiers to +1, sell tiers to -1 and neutral to 0', () => {
    expect(directionOf('strong_buy')).toBe(1);
    expect(directionOf('buy')).toBe(1);
    expect(directionOf('neutral')).toBe(0);
    expect(directionOf('sell')).toBe(-1);
    expect(directionOf('strong_sell')).toBe(-1);
  });
});

describe('outcomeOf', () => {
  it('splits right calls at the cost into won and cost', () => {
    expect(outcomeOf('buy', 0.5, 0.16)).toBe('won');
    expect(outcomeOf('buy', 0.1, 0.16)).toBe('cost');
    expect(outcomeOf('buy', 0.16, 0.16)).toBe('cost');
    expect(outcomeOf('buy', -0.1, 0.16)).toBe('wrong');
  });

  it('judges sell calls on the fall', () => {
    expect(outcomeOf('strong_sell', -0.5, 0.16)).toBe('won');
    expect(outcomeOf('sell', -0.05, 0.16)).toBe('cost');
    expect(outcomeOf('sell', 0.3, 0.16)).toBe('wrong');
  });

  it('counts an unchanged price as wrong, like the hit rule (fwd > 0 for buys)', () => {
    expect(outcomeOf('buy', 0, 0.16)).toBe('wrong');
    expect(outcomeOf('sell', 0, 0.16)).toBe('wrong');
  });

  it('has no outcome for neutral bars or unknown returns', () => {
    expect(outcomeOf('neutral', 1, 0.16)).toBeNull();
    expect(outcomeOf('buy', null, 0.16)).toBeNull();
    expect(outcomeOf('buy', Number.NaN, 0.16)).toBeNull();
  });
});

describe('pointMeasures', () => {
  it('computes every measure on a hand-checked set', () => {
    // buys: +1.0 (right), -0.5 (wrong), +0.1 (right); sells: -0.4 (right), +0.2 (wrong); neutral ignored
    const m = pointMeasures(
      [row('buy', 1.0), row('strong_buy', -0.5), row('buy', 0.1), row('sell', -0.4), row('strong_sell', 0.2), row('neutral', 9)],
      0.16
    );
    expect(m.calls).toBe(5);
    expect(m.buyN).toBe(3);
    expect(m.sellN).toBe(2);
    expect(m.buyHit).toBeCloseTo(2 / 3);
    expect(m.sellHit).toBeCloseTo(1 / 2);
    expect(m.bh).toBeCloseTo((2 / 3 + 1 / 2) / 2);
    expect(m.right).toBeCloseTo(3 / 5);
    // d x fwd: 1.0, -0.5, 0.1, 0.4, -0.2 -> sum 0.8
    expect(m.meanBefore).toBeCloseTo(0.16);
    expect(m.net).toBeCloseTo(0);
    // above 0.16: 1.0 and 0.4
    expect(m.wonAfterCost).toBeCloseTo(2 / 5);
    expect(m.avgWin).toBeCloseTo((1.0 + 0.1 + 0.4) / 3);
    expect(m.avgLoss).toBeCloseTo((0.5 + 0.2) / 2);
    expect(m.breakEven).toBeCloseTo((0.35 + 0.16) / (0.5 + 0.35));
  });

  it('breaks even exactly at the right-share it reports', () => {
    const m = pointMeasures([row('buy', 1), row('buy', -1), row('sell', -2), row('sell', 0.5)], 0.2);
    const p = m.breakEven as number;
    const w = m.avgWin as number;
    const l = m.avgLoss as number;
    expect(p * w - (1 - p) * l - 0.2).toBeCloseTo(0);
  });

  it('returns nulls, never NaN, when a side or every call is missing', () => {
    const none = pointMeasures([row('neutral', 1)], 0.16);
    expect(none.calls).toBe(0);
    expect(none.buyHit).toBeNull();
    expect(none.bh).toBeNull();
    expect(none.right).toBeNull();
    expect(none.net).toBeNull();
    expect(none.breakEven).toBeNull();

    const buysOnly = pointMeasures([row('buy', 1), row('buy', 2)], 0.16);
    expect(buysOnly.sellHit).toBeNull();
    expect(buysOnly.bh).toBeNull();
    expect(buysOnly.right).toBe(1);
    expect(buysOnly.avgLoss).toBeNull();
    expect(buysOnly.breakEven).toBeNull();
  });
});

describe('monthMeasures', () => {
  it('groups by UTC month, oldest first, keeping months without calls', () => {
    const jan31 = Date.UTC(2026, 0, 31, 23, 0);
    const feb1 = Date.UTC(2026, 1, 1, 0, 0);
    const months = monthMeasures(
      [
        { ...row('buy', 1), candleTimestamp: feb1 },
        { ...row('sell', 1), candleTimestamp: jan31 },
        { ...row('neutral', 1), candleTimestamp: Date.UTC(2026, 2, 3) },
      ],
      0.16
    );
    expect(months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(months[0]).toMatchObject({ calls: 1, right: 0 });
    expect(months[1]).toMatchObject({ calls: 1, right: 1 });
    expect(months[2]).toMatchObject({ calls: 0, right: null, net: null });
  });

  it('formats month keys in UTC', () => {
    expect(monthOf(Date.UTC(2025, 9, 1))).toBe('2025-10');
  });
});

describe('tier codes', () => {
  it('round-trips every tier', () => {
    for (const tier of ['strong_sell', 'sell', 'neutral', 'buy', 'strong_buy'] as const) {
      expect(tierFromCode(tierCode(tier))).toBe(tier);
    }
  });

  it('rejects unknown codes', () => {
    expect(() => tierFromCode(3)).toThrow();
  });
});
