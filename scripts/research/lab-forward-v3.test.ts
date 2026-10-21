// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { LAB_FORWARD_V3_LOCK as LOCK } from './lab-forward-v3';
import {
  LAB_HYPOTHESES_V3,
  LAB_TIMEFRAME_MS,
  LAB_V3_THRESHOLD,
  LAB_V3_UNIVERSE,
  LAB_V3_UNIVERSE_SHA256,
  LAB_VERSION_V3,
  labDelayMs,
} from '@/lib/signals/lab/candidates';
import { initialEState } from '@/lib/signals/lab/e-process';
import { gradeBookBar } from '@/lib/signals/lab/job-grade';
import { MIN_SCORED_COINS, MIN_SETTLEMENTS_7D, STAGGER_DAYS } from '@/lib/signals/lab/v3/f1';
import { LAB_COST_PER_SIDE } from '@/lib/signals/lab/hurdle';

const F1_HYP = LAB_HYPOTHESES_V3.find((h) => h.id === 'F1-1d')!;

describe('lab-v3 lock', () => {
  it('freezes version, hypothesis, scale, threshold and universe', () => {
    expect(LAB_VERSION_V3).toBe(LOCK.version);
    expect(
      LAB_HYPOTHESES_V3.map((h) => ({
        id: h.id,
        candidate: h.candidate,
        timeframe: h.timeframe,
        metric: h.metric,
        scale: h.scale,
      }))
    ).toEqual(LOCK.hypotheses);
    for (const h of LAB_HYPOTHESES_V3) expect(h.version).toBe(LOCK.version);
    expect(LAB_V3_THRESHOLD).toBe(LOCK.threshold);
    expect(LOCK.threshold).toBeCloseTo(1 / LOCK.alphaPerSlot, 10);
    expect(LAB_V3_UNIVERSE).toEqual(LOCK.universe);
    expect(LAB_V3_UNIVERSE_SHA256).toBe(LOCK.universeSha256);
    expect(LAB_V3_UNIVERSE.length).toBe(30);
  });

  it('freezes timing: 1d bars, 10m execution delay', () => {
    expect(LAB_TIMEFRAME_MS['1d']).toBe(86_400_000);
    expect(labDelayMs('1d')).toBe(LOCK.delayMs);
    expect(LOCK.delayMs).toBe(600_000);
  });

  it('freezes F1 candidate constants', () => {
    expect(STAGGER_DAYS).toBe(LOCK.f1.staggerDays);
    expect(MIN_SETTLEMENTS_7D).toBe(LOCK.f1.minSettlements7d);
    expect(MIN_SCORED_COINS).toBe(LOCK.f1.minScoredCoins);
    expect(LAB_COST_PER_SIDE).toBe(LOCK.f1.costPerSide);
  });

  it('golden vector: F1 net book return with funding and turnover cost', () => {
    const prev = {
      state: initialEState(),
      weights: { BTCUSDT: 0.25, SOLUSDT: -0.25 } as Record<string, number>,
    };
    const weights = { BTCUSDT: 0.5, ETHUSDT: -0.5 };
    const prices = {
      BTCUSDT: { start: 100, end: 102 },
      ETHUSDT: { start: 100, end: 99 },
    };
    const fundingSums = { BTCUSDT: 0.001, ETHUSDT: -0.002 };

    const turnover = 0.25 + 0.5 + 0.25;
    const expectedR =
      0.5 * (0.02 - 0.001) -
      0.5 * (-0.01 + 0.002) -
      0.0007 * turnover;

    const row = gradeBookBar({
      hypothesis: F1_HYP,
      barClose: Date.UTC(2026, 9, 20),
      gradedAt: new Date(Date.UTC(2026, 9, 21, 1)),
      late: false,
      scores: weights,
      prices,
      fundingSums,
      prev,
    } as Parameters<typeof gradeBookBar>[0]);

    expect(row.netBookReturn).toBeCloseTo(expectedR, 12);
    expect(row.x).toBeCloseTo(Math.min(expectedR / 0.1, 1), 12);
    expect(row.b).toBe(0);
    expect(row.version).toBe('lab-v3');
    expect(row.hypothesis).toBe('F1-1d');
  });

  it('golden vector: grading crosses at threshold 200', () => {
    let state = initialEState();
    let crossedAt: number | null = null;
    const base = Date.UTC(2026, 9, 20);

    for (let i = 0; i < 200 && crossedAt === null; i++) {
      const row = gradeBookBar({
        hypothesis: F1_HYP,
        barClose: base + i * 86_400_000,
        gradedAt: new Date(base + (i + 1) * 86_400_000),
        late: false,
        scores: { BTCUSDT: 0.5, ETHUSDT: -0.5 },
        prices: {
          BTCUSDT: { start: 100, end: 100 * (1 + 0.1 * 0.4 + 0.0007) },
          ETHUSDT: { start: 100, end: 100 * (1 - 0.1 * 0.4 - 0.0007) },
        },
        fundingSums: { BTCUSDT: 0, ETHUSDT: 0 },
        prev: { state, weights: {} },
      } as Parameters<typeof gradeBookBar>[0]);
      state = row.state;
      crossedAt = state.crossedAt;
    }

    expect(crossedAt).not.toBeNull();
    expect(state.logE).toBeGreaterThanOrEqual(Math.log(200));
    expect(state.logE).toBeLessThan(Math.log(400) + 1);
  });
});
