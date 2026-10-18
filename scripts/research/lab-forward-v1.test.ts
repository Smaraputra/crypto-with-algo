import { describe, expect, it } from 'vitest';

import {
  L2_V8_STYLE,
  L3_BARS,
  L4_LAG_MS,
  L4_PERIOD,
  L4_PERIOD_MS,
  L4_POINTS,
  LAB_HYPOTHESES_V1,
  LAB_MIN_CROSS_SECTION,
  LAB_VERSION,
  labDelayMs,
  type LabTimeframe,
} from '@/lib/signals/lab/candidates';
import {
  LAB_ALPHA,
  LAB_CAP_NUMERATOR,
  LAB_HYPOTHESES,
  LAB_THRESHOLD,
  LAB_VARIANCE_EPS,
  LAB_WARMUP_BARS,
} from '@/lib/signals/lab/e-process';
import { L2_WEIGHTS } from '@/lib/signals/lab/factors';
import { LAB_COST_PER_SIDE, LAB_S_WINDOW } from '@/lib/signals/lab/hurdle';
import { LAB_FORWARD_V1_LOCK as LOCK } from './lab-forward-v1';

// The lab's code must run exactly the locked values. A change to either side fails here, and changing
// the lock after the first graded bar needs an AMENDMENT that only tightens.
describe('lab-forward-v1 lock', () => {
  it('freezes the version and the eight hypotheses in order', () => {
    expect(LAB_VERSION).toBe(LOCK.version);
    expect(LAB_HYPOTHESES_V1.map((h) => h.id)).toEqual([...LOCK.hypotheses]);
    expect(LAB_HYPOTHESES).toBe(LOCK.hypotheses.length);
  });

  it('freezes the test', () => {
    expect(LAB_ALPHA).toBe(LOCK.alpha);
    expect(LAB_THRESHOLD).toBe(LOCK.threshold);
    expect(LAB_WARMUP_BARS).toBe(LOCK.warmupBars);
    expect(LAB_VARIANCE_EPS).toBe(LOCK.varianceEps);
    expect(LAB_CAP_NUMERATOR).toBe(LOCK.capNumerator);
  });

  it('freezes the hurdle and the metric inputs', () => {
    expect(LAB_COST_PER_SIDE).toBe(LOCK.costPerSide);
    expect(LAB_S_WINDOW).toBe(LOCK.sWindow);
    expect(LAB_MIN_CROSS_SECTION).toBe(LOCK.minCrossSection);
    for (const tf of Object.keys(LOCK.delayMs) as LabTimeframe[]) {
      expect(labDelayMs(tf)).toBe(LOCK.delayMs[tf]);
    }
  });

  it('freezes the candidates', () => {
    expect(L2_WEIGHTS).toEqual(LOCK.l2Weights);
    expect(L2_V8_STYLE).toEqual(LOCK.l2V8Style);
    expect(L3_BARS).toBe(LOCK.l3Bars);
    expect(L4_PERIOD).toBe(LOCK.l4.period);
    expect(L4_PERIOD_MS).toBe(LOCK.l4.periodMs);
    expect(L4_POINTS).toBe(LOCK.l4.points);
    expect(L4_LAG_MS).toBe(LOCK.l4.lagMs);
  });
});
