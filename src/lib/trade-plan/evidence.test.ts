// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';
import { STRATEGY_EXIT_LEVEL, TIER_BUY_CUTOFF } from '@/lib/signals/calibration';
import { CONTROL_EVIDENCE, evidenceFor } from './evidence';

describe('CONTROL_EVIDENCE', () => {
  it('has a row for every interval a style scores', () => {
    const intervals = new Set(Object.values(STYLE_CONFIGS).flatMap((c) => c.preferredIntervals));
    for (const interval of intervals) {
      expect(CONTROL_EVIDENCE[interval]?.interval).toBe(interval);
    }
  });

  it('marks as current only the rows measured at today\'s thresholds', () => {
    for (const row of Object.values(CONTROL_EVIDENCE)) {
      if (row.status === 'current') {
        expect(row.thresholds).toEqual({ entry: TIER_BUY_CUTOFF, exit: STRATEGY_EXIT_LEVEL });
      } else if (row.status === 'stale') {
        expect(row.thresholds).not.toEqual({ entry: TIER_BUY_CUTOFF, exit: STRATEGY_EXIT_LEVEL });
      }
    }
  });

  it('records the v7 15m and 1h controls from the session 17 audit', () => {
    expect(CONTROL_EVIDENCE['15m']).toMatchObject({
      status: 'current',
      trades: 4796,
      expectancyPercent: -0.1175,
      ciLowPercent: -0.174,
      ciHighPercent: -0.0583,
      medianHoldBars: 7,
    });
    expect(CONTROL_EVIDENCE['1h']).toMatchObject({
      status: 'current',
      trades: 8436,
      expectancyPercent: -0.0687,
      ciLowPercent: -0.1741,
      ciHighPercent: 0.0385,
      medianHoldBars: 7,
    });
  });

  it('flags 5m, 4h and 1d as the Phase 4 rule and 1m as unmeasured', () => {
    expect(CONTROL_EVIDENCE['5m'].status).toBe('stale');
    expect(CONTROL_EVIDENCE['4h'].status).toBe('stale');
    expect(CONTROL_EVIDENCE['1d'].status).toBe('stale');
    expect(CONTROL_EVIDENCE['1m']).toMatchObject({ status: 'none', trades: null, expectancyPercent: null });
  });

  it('never claims an interval that excludes zero on the positive side', () => {
    for (const row of Object.values(CONTROL_EVIDENCE)) {
      if (row.ciLowPercent !== null) expect(row.ciLowPercent).toBeLessThan(0);
    }
  });
});

describe('evidenceFor', () => {
  it('returns the recorded row', () => {
    expect(evidenceFor('1h')).toBe(CONTROL_EVIDENCE['1h']);
  });

  it('returns an explicit unmeasured row for an interval with no record', () => {
    expect(evidenceFor('30m')).toMatchObject({ interval: '30m', status: 'none', trades: null });
  });
});
