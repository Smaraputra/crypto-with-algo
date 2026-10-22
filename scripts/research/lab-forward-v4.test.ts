// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { LAB_FORWARD_V4_LOCK as LOCK } from './lab-forward-v4';
import { ROUND_TRIP_COST } from './lab-v4-preview';
import { ledgerTotal } from './ledger';
import { DIVERGENCE_MAX_BARS } from '@/lib/market/delta';
import { SWING_LENGTH } from '@/lib/market/structure';
import {
  LAB_HYPOTHESES_V4,
  LAB_V4_HOLD_MS,
  LAB_V4_ROUND_TRIP,
  LAB_V4_THRESHOLD,
  LAB_VERSION_V4,
  labDelayMs,
} from '@/lib/signals/lab/candidates';
import { initialEState } from '@/lib/signals/lab/e-process';
import { gradeTradeBar } from '@/lib/signals/lab/v4/grade';
import { LAB_V4_WINDOW_BARS } from '@/lib/signals/lab/v4/rules';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

describe('lab-v4 lock', () => {
  it('freezes version, hypotheses, scales and threshold', () => {
    expect(LAB_VERSION_V4).toBe(LOCK.version);
    expect(
      LAB_HYPOTHESES_V4.map((h) => ({
        id: h.id,
        candidate: h.candidate,
        timeframe: h.timeframe,
        metric: h.metric,
        scale: h.scale,
      }))
    ).toEqual(
      LOCK.hypotheses.map((h) => ({
        id: h.id,
        candidate: h.candidate,
        timeframe: h.timeframe,
        metric: h.metric,
        scale: h.scale,
      }))
    );
    for (const h of LAB_HYPOTHESES_V4) {
      expect(h.version).toBe('lab-v4');
    }
    expect(LAB_V4_THRESHOLD).toBe(LOCK.threshold);
    expect(LOCK.threshold).toBeCloseTo(1 / LOCK.alphaPerSlot, 9);
    expect(LOCK.slots * LOCK.alphaPerSlot).toBeCloseTo(0.0025, 9);
  });

  it('freezes timing, hold, costs and window parameters', () => {
    expect(labDelayMs('1h')).toBe(LOCK.delayMs);
    expect(LAB_V4_HOLD_MS).toBe(LOCK.holdMs);
    expect(LAB_V4_ROUND_TRIP).toBe(LOCK.roundTrip);
    expect(LAB_V4_WINDOW_BARS).toBe(LOCK.windowBars);
    expect(SWING_LENGTH).toBe(LOCK.swingLength);
    expect(DIVERGENCE_MAX_BARS).toBe(LOCK.divergenceMaxBars);
    expect(ROUND_TRIP_COST).toBe(LOCK.roundTrip);
  });

  it('freezes ledger trial total and universe', () => {
    expect(ledgerTotal()).toBe(LOCK.ledgerTotal);
    expect([...SIGNAL_SYMBOLS]).toEqual([...LOCK.universe]);
    expect(LOCK.universe.length).toBe(10);
  });

  it('golden vector through gradeTradeBar with LAB_HYPOTHESES_V4[0]', () => {
    const hypothesis = LAB_HYPOTHESES_V4[0];
    const barClose = Date.UTC(2026, 9, 22, 12, 0);
    const gradedAt = new Date(Date.UTC(2026, 9, 22, 21, 0));

    const scores = { BTCUSDT: 1, ETHUSDT: -1 };
    const prices = {
      BTCUSDT: { start: 100, end: 101 },
      ETHUSDT: { start: 50, end: 49.5 },
    };
    const funding = {
      BTCUSDT: 0.0001,
      ETHUSDT: -0.0002,
    };

    const expectedR =
      1 * (0.01 - 0.0001) - 0.0014 + (-1) * (-0.01 - (-0.0002)) - 0.0014;
    const expectedX = Math.min(expectedR / 0.15, 1);

    const row = gradeTradeBar({
      hypothesis,
      barClose,
      late: false,
      scores,
      prices,
      funding,
      prev: { state: initialEState(), weights: {} },
      gradedAt,
    });

    expect(row.netBookReturn).toBeCloseTo(expectedR, 12);
    expect(row.x).toBeCloseTo(expectedX, 12);
    expect(row.version).toBe('lab-v4');
    expect(row.hypothesis).toBe('S1-1h');
    expect(row.b).toBe(0);
  });
});
