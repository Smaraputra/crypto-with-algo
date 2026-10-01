// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';
import { STRATEGY_EXIT_LEVEL, TIER_BUY_CUTOFF } from '@/lib/signals/calibration';
import { CONTROL_EVIDENCE, evidenceFor, evidenceVerdictKind } from './evidence';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';

describe('CONTROL_EVIDENCE', () => {
  it('has a row for every interval a style scores', () => {
    const intervals = new Set(Object.values(STYLE_CONFIGS).flatMap((c) => c.preferredIntervals));
    for (const interval of intervals) {
      expect(CONTROL_EVIDENCE[interval]?.interval).toBe(interval);
    }
  });

  it('reports as current only the rows measured at today\'s thresholds', () => {
    for (const interval of Object.keys(CONTROL_EVIDENCE)) {
      const row = evidenceFor(interval);
      if (row.status === 'current') {
        expect(row.thresholds).toEqual({ entry: TIER_BUY_CUTOFF, exit: STRATEGY_EXIT_LEVEL });
      }
    }
  });

  it('records the v8 15m and 1h controls re-run on 2026-10-02', () => {
    expect(CONTROL_EVIDENCE['15m']).toMatchObject({
      status: 'current',
      trades: 4766,
      expectancyPercent: -0.1345,
      ciLowPercent: -0.1914,
      ciHighPercent: -0.0793,
      medianHoldBars: 7,
      sdPercentRaw: 1.001,
      sdPercentEffective: 1.974,
      tradesPerDay: 23.87,
    });
    expect(CONTROL_EVIDENCE['1h']).toMatchObject({
      status: 'current',
      trades: 8467,
      expectancyPercent: -0.0551,
      ciLowPercent: -0.1527,
      ciHighPercent: 0.0458,
      medianHoldBars: 7,
      sdPercentRaw: 2.42,
      sdPercentEffective: 4.658,
      tradesPerDay: 8.27,
    });
    expect(evidenceFor('15m').status).toBe('current');
    expect(evidenceFor('1h').status).toBe('current');
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
  it('returns the recorded row, its status derived for today', () => {
    const derived = evidenceFor('1h');
    expect({ ...derived, status: CONTROL_EVIDENCE['1h'].status }).toEqual(CONTROL_EVIDENCE['1h']);
    expect(['current', 'stale']).toContain(derived.status);
  });

  it('returns an explicit unmeasured row for an interval with no record', () => {
    expect(evidenceFor('30m')).toMatchObject({ interval: '30m', status: 'none', trades: null });
  });
});

describe('evidenceVerdictKind', () => {
  it('reads a whole interval below zero as a proven loss', () => {
    expect(evidenceVerdictKind(CONTROL_EVIDENCE['15m'])).toBe('loses');
  });
  it('reads a negative estimate whose interval spans zero as negative, not proven', () => {
    expect(evidenceVerdictKind(CONTROL_EVIDENCE['1h'])).toBe('negative');
  });
  it('reads a negative estimate with only a recorded low bound as negative', () => {
    expect(evidenceVerdictKind(CONTROL_EVIDENCE['5m'])).toBe('negative');
  });
  it('reads a non-negative estimate as other, and no run as unmeasured', () => {
    expect(evidenceVerdictKind(CONTROL_EVIDENCE['4h'])).toBe('other');
    expect(evidenceVerdictKind(CONTROL_EVIDENCE['1m'])).toBe('unmeasured');
  });
  it('records the scorer version of each run, null for runs before v5', () => {
    expect(CONTROL_EVIDENCE['15m'].configVersion).toBe(8);
    expect(CONTROL_EVIDENCE['1h'].configVersion).toBe(8);
    expect(CONTROL_EVIDENCE['5m'].configVersion).toBeNull();
    expect(CONTROL_EVIDENCE['1m'].configVersion).toBeNull();
  });
});

describe('evidenceFor: status follows the live scorer version', () => {
  it('is current only for a row measured under SCORER_CONFIG_VERSION at today\'s levels', () => {
    for (const [interval, row] of Object.entries(CONTROL_EVIDENCE)) {
      const derived = evidenceFor(interval).status;
      if (row.status === 'none') {
        expect(derived).toBe('none');
      } else {
        const matches =
          row.configVersion === SCORER_CONFIG_VERSION &&
          row.thresholds?.entry === TIER_BUY_CUTOFF &&
          row.thresholds?.exit === STRATEGY_EXIT_LEVEL;
        expect(derived).toBe(matches ? 'current' : 'stale');
      }
    }
  });

  it('turns a row from an earlier scorer stale without editing the table', () => {
    const row = CONTROL_EVIDENCE['1h'];
    const saved = row.configVersion;
    try {
      row.configVersion = SCORER_CONFIG_VERSION - 1;
      expect(evidenceFor('1h').status).toBe('stale');
    } finally {
      row.configVersion = saved;
    }
    expect(evidenceFor('1h').status).toBe('current');
  });
});
