import { describe, expect, it } from 'vitest';

import { LAB_FORWARD_V2_LOCK as LOCK } from './lab-forward-v2';
import {
  LAB_HYPOTHESES_V2,
  LAB_TIMEFRAME_MS,
  LAB_V2_THRESHOLD,
  LAB_VERSION_V2,
  labDelayMs,
} from '@/lib/signals/lab/candidates';
import {
  initialEState,
  LAB_CAP_NUMERATOR,
  LAB_VARIANCE_EPS,
  LAB_WARMUP_BARS,
} from '@/lib/signals/lab/e-process';
import { gradeBookBar } from '@/lib/signals/lab/job-grade';
import { latestClose } from '@/lib/signals/lab/job-signals';
import { addMonthsUtc, labStatus } from '@/lib/signals/lab/view';
import { N2 } from '@/lib/signals/lab/v2/n2';
import { N3 } from '@/lib/signals/lab/v2/n3';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

const N2_HYP = LAB_HYPOTHESES_V2.find((h) => h.id === 'N2-1w')!;
const N3_HYP = LAB_HYPOTHESES_V2.find((h) => h.id === 'N3-1d')!;

describe('lab-v2 lock', () => {
  it('freezes the version, hypotheses, scales and threshold', () => {
    expect(LAB_VERSION_V2).toBe(LOCK.version);
    expect(
      LAB_HYPOTHESES_V2.map((h) => ({
        id: h.id,
        candidate: h.candidate,
        timeframe: h.timeframe,
        metric: h.metric,
        scale: h.scale,
      }))
    ).toEqual(LOCK.hypotheses);
    for (const h of LAB_HYPOTHESES_V2) expect(h.version).toBe(LOCK.version);
    expect(LAB_V2_THRESHOLD).toBe(LOCK.threshold);
    expect(LOCK.threshold).toBeCloseTo(1 / LOCK.alphaPerSlot, 10);
  });

  it('freezes the e-process rule shared with lab-v1', () => {
    expect(LAB_WARMUP_BARS).toBe(LOCK.warmupBars);
    expect(LAB_CAP_NUMERATOR).toBe(LOCK.capNumerator);
    expect(LAB_VARIANCE_EPS).toBe(LOCK.varianceEps);
    expect(labDelayMs('1w')).toBe(LOCK.delayMs);
    expect(labDelayMs('1d')).toBe(LOCK.delayMs);
  });

  it('freezes the bars: a 7-day week aligned to Monday 00:00 UTC, and the universe', () => {
    expect(LAB_TIMEFRAME_MS['1w']).toBe(7 * 86_400_000);
    expect(latestClose(Date.UTC(2026, 9, 21, 12, 0), '1w')).toBe(Date.UTC(2026, 9, 19));
    expect(new Date(latestClose(Date.UTC(2027, 2, 3, 9, 0), '1w')).getUTCDay()).toBe(1);
    expect([...SIGNAL_SYMBOLS]).toEqual(LOCK.universe);
  });

  it('freezes the N2 and N3 rule constants', () => {
    for (const [key, value] of Object.entries(LOCK.n2)) {
      expect((N2 as Record<string, unknown>)[key]).toBe(value);
    }
    for (const [key, value] of Object.entries(LOCK.n3)) {
      expect((N3 as Record<string, unknown>)[key]).toBe(value);
    }
  });

  it('freezes the 24-month read rule', () => {
    const first = Date.UTC(2026, 9, 19);
    const end = addMonthsUtc(first, LOCK.maxMonths);
    expect(labStatus({ firstGradedAt: first, crossedAt: null, now: end - 1 })).toBe('under_test');
    expect(labStatus({ firstGradedAt: first, crossedAt: null, now: end + 1 })).toBe('not_shown');
  });

  it('golden vector: N2 net book return with funding and turnover cost, gains-only clip', () => {
    const prev = { state: initialEState(), weights: { A: 0.25, C: -0.25 } as Record<string, number> };
    const row = gradeBookBar({
      hypothesis: N2_HYP,
      barClose: Date.UTC(2026, 9, 19),
      gradedAt: new Date(Date.UTC(2026, 9, 26, 1)),
      late: false,
      scores: { A: 0.5, B: -0.5 },
      prices: { A: { start: 100, end: 102 }, B: { start: 50, end: 49.5 } },
      fundingSums: { A: 0.001, B: -0.002 },
      prev,
    } as Parameters<typeof gradeBookBar>[0]);
    const expected = 0.5 * (0.02 - 0.001) - 0.5 * (-0.01 + 0.002) - 0.0007 * (0.25 + 0.5 + 0.25);
    expect(row.netBookReturn).toBeCloseTo(expected, 12);
    expect(row.x).toBeCloseTo(Math.min(expected / 0.13, 1), 12);
    expect(row.b).toBe(0);
  });

  it('golden vector: N3 sum of one-unit trades with funding and cost', () => {
    const row = gradeBookBar({
      hypothesis: N3_HYP,
      barClose: Date.UTC(2026, 9, 19),
      gradedAt: new Date(Date.UTC(2026, 9, 20, 1)),
      late: false,
      scores: { A: 1, B: 1, C: -1 },
      prices: {
        A: { start: 100, end: 101 },
        B: { start: 10, end: 9.9 },
        C: { start: 20, end: 19.6 },
      },
      fundingSums: { A: 0.0003, B: 0.0001, C: -0.0002 },
      prev: { state: initialEState(), weights: {} },
    } as Parameters<typeof gradeBookBar>[0]);
    const expected =
      1 * (0.01 - 0.0003) - 0.0014 + 1 * (-0.01 - 0.0001) - 0.0014 + -1 * (-0.02 + 0.0002) - 0.0014;
    expect(row.netBookReturn).toBeCloseTo(expected, 12);
    expect(row.x).toBeCloseTo(Math.min(expected / 0.8, 1), 12);
  });

  it('golden vector: grading crosses at threshold 400, not 800', () => {
    // A warmed-up state with a strongly positive mean puts λ at its 0.5 cap.
    let state = initialEState();
    let crossedAt: number | null = null;
    const base = Date.UTC(2026, 9, 19);
    for (let i = 0; i < 400 && crossedAt === null; i++) {
      const row = gradeBookBar({
        hypothesis: N3_HYP,
        barClose: base + i * 86_400_000,
        gradedAt: new Date(base + (i + 1) * 86_400_000),
        late: false,
        scores: { A: 1 },
        prices: { A: { start: 100, end: 100 * (1 + 0.8 * 0.3 + 0.0014) } },
        fundingSums: { A: 0 },
        prev: { state, weights: {} },
      } as Parameters<typeof gradeBookBar>[0]);
      state = row.state;
      crossedAt = state.crossedAt;
    }
    expect(crossedAt).not.toBeNull();
    expect(state.logE).toBeGreaterThanOrEqual(Math.log(400));
    expect(state.logE).toBeLessThan(Math.log(800) + 1);
  });
});
