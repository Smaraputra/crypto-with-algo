// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { FUNDING_INTERVAL_MS, fundingCrossings, fundingPnl } from './funding';
import { snapshotToScorerInputs } from './snapshot-series';

describe('FUNDING_INTERVAL_MS', () => {
  it('is 8 hours in milliseconds', () => {
    expect(FUNDING_INTERVAL_MS).toBe(8 * 60 * 60 * 1000);
  });
});

describe('fundingCrossings', () => {
  it('is 0 for a bar fully inside a funding period', () => {
    // 01:00 -> 02:00, both inside the 00:00-08:00 period
    expect(fundingCrossings(1 * 60 * 60 * 1000, 2 * 60 * 60 * 1000)).toBe(0);
  });

  it('is 1 for a 1h bar spanning the 08:00 UTC boundary', () => {
    // 07:00 -> 08:00
    expect(fundingCrossings(7 * 60 * 60 * 1000, 8 * 60 * 60 * 1000)).toBe(1);
  });

  it('is 3 for a 1d bar', () => {
    // 00:00 -> 24:00 the next day covers 08:00, 16:00, and 24:00
    expect(fundingCrossings(0, 24 * 60 * 60 * 1000)).toBe(3);
  });

  it('does not count a funding timestamp equal to prevCloseTime', () => {
    // prevCloseTime lands exactly on the 08:00 boundary; a bar starting there
    // must not recount it
    expect(fundingCrossings(8 * 60 * 60 * 1000, 8 * 60 * 60 * 1000 + 1)).toBe(0);
  });

  it('counts a funding timestamp equal to closeTime', () => {
    expect(fundingCrossings(7 * 60 * 60 * 1000 + 1, 8 * 60 * 60 * 1000)).toBe(1);
  });

  it('returns 0 when prevCloseTime equals closeTime', () => {
    expect(fundingCrossings(8 * 60 * 60 * 1000, 8 * 60 * 60 * 1000)).toBe(0);
  });

  it('returns 0 when closeTime is before prevCloseTime', () => {
    expect(fundingCrossings(8 * 60 * 60 * 1000, 1 * 60 * 60 * 1000)).toBe(0);
  });
});

describe('fundingPnl', () => {
  it('a long pays when the rate is positive', () => {
    expect(fundingPnl(10000, 0.0001, 'long', 1)).toBeCloseTo(-1);
  });

  it('a short receives when the rate is positive', () => {
    expect(fundingPnl(10000, 0.0001, 'short', 1)).toBeCloseTo(1);
  });

  it('a long receives when the rate is negative', () => {
    expect(fundingPnl(10000, -0.0001, 'long', 1)).toBeCloseTo(1);
  });

  it('a short pays when the rate is negative', () => {
    expect(fundingPnl(10000, -0.0001, 'short', 1)).toBeCloseTo(-1);
  });

  it('scales linearly with crossings', () => {
    expect(fundingPnl(10000, 0.0001, 'long', 3)).toBeCloseTo(-3);
  });

  it('is 0 with 0 crossings regardless of rate or side', () => {
    expect(fundingPnl(10000, 0.0001, 'long', 0)).toBeCloseTo(0);
    expect(fundingPnl(10000, 0.0001, 'short', 0)).toBeCloseTo(0);
  });
});

describe('sign convention against a realistic ingested snapshot document', () => {
  it('a long pays funding derived from a snapshot document with a positive rate', () => {
    const { futures } = snapshotToScorerInputs(
      { fundingRate: { rate: 0.0001, markPrice: 65000 } },
      'BTCUSDT',
      1700000000000
    );

    const rate = futures!.fundingRate!.fundingRate;
    expect(rate).toBe(0.0001);
    expect(fundingPnl(10000, rate, 'long', 1)).toBeLessThan(0);
    expect(fundingPnl(10000, rate, 'short', 1)).toBeGreaterThan(0);
  });
});
