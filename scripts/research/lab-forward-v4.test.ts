// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LAB_FORWARD_V4_LOCK as LOCK } from './lab-forward-v4';
import { ROUND_TRIP_COST } from './lab-v4-preview';
import { ledgerTotal } from './ledger';
import { DIVERGENCE_MAX_BARS } from '@/lib/market/delta';
import { SWING_LENGTH } from '@/lib/market/structure';
import { LAB_V4_DAILY_START_MS } from '@/lib/signals/lab/job-grade-v4';
import {
  LAB_HYPOTHESES_V4,
  LAB_HYPOTHESES_V4_DAILY,
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
    // The lock froze the total at its registration; later studies add entries after it.
    expect(ledgerTotal('round3-lab-v4-preview')).toBe(LOCK.ledgerTotal);
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

  it('pins the amendment 2 text marker and daily scales', () => {
    expect(LOCK.dailyScale).toEqual({ S1: 0.19, S2: 0.18 });
    expect(LOCK.dailyScale.S1).toBe(0.19);
    expect(LOCK.dailyScale.S2).toBe(0.18);
    expect(LAB_HYPOTHESES_V4_DAILY[0]?.scale).toBe(LOCK.dailyScale.S1);
    expect(LAB_HYPOTHESES_V4_DAILY[1]?.scale).toBe(LOCK.dailyScale.S2);
    const content = readFileSync(new URL('./lab-forward-v4.ts', import.meta.url), 'utf8');
    expect(content).toContain('AMENDMENT 2');
    expect(content).toContain("Ville's bound for S1");
  });

  it('pins the amendment 3 start record: the daily statistic starts on 2026-10-26 00:00 UTC', () => {
    expect(LAB_V4_DAILY_START_MS).toBe(Date.UTC(2026, 9, 26));
    expect(LAB_V4_DAILY_START_MS).toBe(1792972800000);
    const content = readFileSync(new URL('./lab-forward-v4.ts', import.meta.url), 'utf8');
    expect(content).toContain('AMENDMENT 3 (2026-10-25, start record for AMENDMENT 2)');
    expect(content).toContain('(1792972800000)');
  });
});
