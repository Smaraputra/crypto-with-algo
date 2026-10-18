import { describe, expect, it } from 'vitest';

import { HOLDOUT_A } from './dataset-format';
import { ledgerTotal, LEDGER } from './ledger';
import { NV1_C1 } from './nv1-c1';
import { NV1_C2 } from './nv1-c2';
import { NV1_C3 } from './nv1-c3';
import { NV1_SEGMENTS } from './nv1-core';
import { NV1_LOCK as LOCK } from './next-version-v1';

// The round's code must run exactly the locked values. A change to either side fails here, and a change
// to the lock after segment A is read needs an AMENDMENT that only tightens.
describe('next-version-v1 lock', () => {
  it('freezes the segments, and A ends where the loader guard ends', () => {
    expect(NV1_SEGMENTS).toEqual(LOCK.segments);
    expect(LOCK.segments.A2.end).toBe(HOLDOUT_A.spotIntradayEnd);
    expect(LOCK.segments.A1.end).toBe(HOLDOUT_A.spotDailyEnd);
  });

  it('freezes C1', () => {
    expect([...NV1_C1.ks]).toEqual([...LOCK.c1.ks]);
    expect(NV1_C1.hold).toBe(LOCK.c1.hold);
    expect(NV1_C1.costPct).toBe(LOCK.c1.costPct);
    expect(NV1_C1.minShiftBars).toBe(LOCK.c1.minShiftBars);
    expect(NV1_C1.minTrades).toBe(LOCK.c1.minTrades);
    expect(NV1_C1.minBlocks).toBe(LOCK.c1.minBlocks);
    expect(NV1_C1.alpha).toBe(LOCK.c1.alpha);
    expect(NV1_C1.testStandardiseDraws).toBe(LOCK.c1.testStandardiseDraws);
    expect(NV1_C1.testStandardiseSeed).toBe(LOCK.c1.testStandardiseSeed);
    expect(NV1_C1.testNullDraws).toBe(LOCK.c1.testNullDraws);
    expect(NV1_C1.testNullSeed).toBe(LOCK.c1.testNullSeed);
    expect(LOCK.c1.c85).toBeLessThan(LOCK.c1.c90);
    expect(LOCK.c1.c90).toBeLessThan(LOCK.c1.c95);
  });

  it('freezes C2', () => {
    expect({ ...NV1_C2, ks: [...NV1_C2.ks], lookbackWeeks: [...NV1_C2.lookbackWeeks] }).toEqual({
      ...LOCK.c2,
      ks: [...LOCK.c2.ks],
      lookbackWeeks: [...LOCK.c2.lookbackWeeks],
    });
  });

  it('freezes C3', () => {
    expect({ ...NV1_C3, ks: [...NV1_C3.ks], plateauThresholds: [...NV1_C3.plateauThresholds] }).toEqual({
      ...LOCK.c3,
      ks: [...LOCK.c3.ks],
      plateauThresholds: [...LOCK.c3.plateauThresholds],
    });
  });

  it('moves the ledger by the round\'s 20 trials', () => {
    expect(LOCK.ledgerAfter - LOCK.ledgerBefore).toBe(20);
    expect(ledgerTotal('baseline-2026-10-18')).toBe(LOCK.ledgerBefore);
    const entry = LEDGER.find((e) => e.id === 'next-version-r1');
    expect(entry?.trials).toBe(20);
    expect(ledgerTotal('next-version-r1')).toBe(LOCK.ledgerAfter);
  });

  it('fixes the lab-v2 alpha split before any read', () => {
    expect(LOCK.labV2.slots * LOCK.labV2.alphaPerSlot).toBeCloseTo(0.01, 12);
    expect(LOCK.labV2.threshold).toBe(1 / LOCK.labV2.alphaPerSlot);
  });
});
