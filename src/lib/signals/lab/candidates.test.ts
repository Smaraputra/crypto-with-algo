import { describe, expect, it } from 'vitest';
import { LAB_HYPOTHESES } from './e-process';
import {
  LAB_HYPOTHESES_V1,
  LAB_HYPOTHESES_V4_DAILY,
  LAB_MIN_CROSS_SECTION,
  LAB_TIMEFRAME_MS,
  LAB_V4_DAILY_SCALE,
  LAB_VERSION,
  L2_V8_STYLE,
  L3_BARS,
  L4_LAG_MS,
  L4_PERIOD,
  L4_PERIOD_MS,
  L4_POINTS,
  labDelayMs,
} from './candidates';

describe('candidates registry', () => {
  it('defines 8 hypotheses with expected ids, version lab-v1 and matching LAB_HYPOTHESES', () => {
    expect(LAB_HYPOTHESES_V1.length).toBe(8);
    expect(LAB_HYPOTHESES_V1.length).toBe(LAB_HYPOTHESES);

    const expectedIds = [
      'L1-8h',
      'L2-5m',
      'L2-15m',
      'L2-1h',
      'L2-4h',
      'L2-1d',
      'L3-8h',
      'L4-8h',
    ];

    expect(LAB_HYPOTHESES_V1.map((h) => h.id)).toEqual(expectedIds);

    for (const h of LAB_HYPOTHESES_V1) {
      expect(h.version).toBe('lab-v1');
      expect(h.id).toBe(`${h.candidate}-${h.timeframe}`);
    }
  });

  it('freezes the hypotheses array and each entry', () => {
    expect(Object.isFrozen(LAB_HYPOTHESES_V1)).toBe(true);
    for (const h of LAB_HYPOTHESES_V1) {
      expect(Object.isFrozen(h)).toBe(true);
    }
  });

  it('returns 300,000 ms delay for 5m and 600,000 ms delay for every other timeframe', () => {
    expect(labDelayMs('5m')).toBe(300_000);
    expect(labDelayMs('15m')).toBe(600_000);
    expect(labDelayMs('1h')).toBe(600_000);
    expect(labDelayMs('4h')).toBe(600_000);
    expect(labDelayMs('8h')).toBe(600_000);
    expect(labDelayMs('1d')).toBe(600_000);
  });

  it('maps L2 timeframes to the exact v8 style mapping', () => {
    expect(L2_V8_STYLE).toEqual({
      '5m': 'scalping',
      '15m': 'day_trading',
      '1h': 'day_trading',
      '4h': 'swing_trading',
      '1d': 'swing_trading',
    });
    expect(Object.isFrozen(L2_V8_STYLE)).toBe(true);
  });

  it('exports expected candidate constants', () => {
    expect(LAB_VERSION).toBe('lab-v1');
    expect(LAB_MIN_CROSS_SECTION).toBe(8);
    expect(L3_BARS).toBe(169);
    expect(L4_PERIOD).toBe('4h');
    expect(L4_PERIOD_MS).toBe(4 * 3_600_000);
    expect(L4_POINTS).toBe(180);
    expect(L4_LAG_MS).toBe(4 * 3_600_000);
    expect(LAB_TIMEFRAME_MS['5m']).toBe(300_000);
    expect(LAB_TIMEFRAME_MS['15m']).toBe(900_000);
    expect(LAB_TIMEFRAME_MS['1h']).toBe(3_600_000);
    expect(LAB_TIMEFRAME_MS['4h']).toBe(14_400_000);
    expect(LAB_TIMEFRAME_MS['8h']).toBe(28_800_000);
    expect(LAB_TIMEFRAME_MS['1d']).toBe(86_400_000);
  });

  it('freezes LAB_HYPOTHESES_V4_DAILY and LAB_V4_DAILY_SCALE', () => {
    expect(LAB_HYPOTHESES_V4_DAILY.length).toBe(2);
    expect(LAB_HYPOTHESES_V4_DAILY.map((h) => h.id)).toEqual(['S1-1h-daily', 'S2-1h-daily']);
    expect(Object.isFrozen(LAB_HYPOTHESES_V4_DAILY)).toBe(true);
    for (const h of LAB_HYPOTHESES_V4_DAILY) {
      expect(Object.isFrozen(h)).toBe(true);
      expect(h.version).toBe('lab-v4');
      expect(h.timeframe).toBe('1d');
      expect(h.metric).toBe('book');
    }
    expect(LAB_V4_DAILY_SCALE).toEqual({ S1: 0.19, S2: 0.18 });
    expect(Object.isFrozen(LAB_V4_DAILY_SCALE)).toBe(true);
  });
});
