import { describe, it, expect } from 'vitest';
import {
  MARKET_SESSIONS,
  SESSION_UTC_RANGES,
  getSession,
  sessionOfCandleClose,
  isSessionMeaningful,
} from './sessions';
import { intervalToMs } from './intervals';

// 2023-11-15T00:00:00.000Z, a UTC midnight
const UTC_MIDNIGHT = 1700006400000;
const HOUR = 60 * 60 * 1000;

function atUtcHour(hour: number): number {
  return UTC_MIDNIGHT + hour * HOUR;
}

describe('getSession', () => {
  it('maps every boundary hour to the correct session', () => {
    expect(getSession(atUtcHour(0))).toBe('asia');
    expect(getSession(atUtcHour(6))).toBe('asia');
    expect(getSession(atUtcHour(7))).toBe('london');
    expect(getSession(atUtcHour(11))).toBe('london');
    expect(getSession(atUtcHour(12))).toBe('ny_overlap');
    expect(getSession(atUtcHour(15))).toBe('ny_overlap');
    expect(getSession(atUtcHour(16))).toBe('new_york');
    expect(getSession(atUtcHour(20))).toBe('new_york');
    expect(getSession(atUtcHour(21))).toBe('off_hours');
    expect(getSession(atUtcHour(23))).toBe('off_hours');
  });

  it('wraps around midnight into asia', () => {
    expect(getSession(atUtcHour(24))).toBe('asia');
    expect(getSession(atUtcHour(23) + HOUR - 1)).toBe('off_hours');
  });

  it('covers all 24 hours with the five sessions', () => {
    const seen = new Set<string>();
    for (let h = 0; h < 24; h++) {
      seen.add(getSession(atUtcHour(h)));
    }
    expect([...seen].sort()).toEqual([...MARKET_SESSIONS].sort());
  });

  it('ranges are contiguous and mutually exclusive', () => {
    const sorted = [...SESSION_UTC_RANGES].sort((a, b) => a.startHour - b.startHour);
    expect(sorted[0].startHour).toBe(0);
    expect(sorted[sorted.length - 1].endHour).toBe(24);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startHour).toBe(sorted[i - 1].endHour);
    }
  });
});

describe('sessionOfCandleClose', () => {
  it('uses the close time, not the open time', () => {
    // A 1h bar opening 11:00 UTC closes 12:00 -> ny_overlap, not london
    expect(sessionOfCandleClose(atUtcHour(11), intervalToMs('1h'))).toBe('ny_overlap');
    // A 1h bar opening 10:00 UTC closes 11:00 -> london
    expect(sessionOfCandleClose(atUtcHour(10), intervalToMs('1h'))).toBe('london');
  });

  it('handles 5m bars near a boundary', () => {
    // 06:55 open closes at 07:00 -> london
    expect(sessionOfCandleClose(atUtcHour(6) + 55 * 60 * 1000, intervalToMs('5m'))).toBe('london');
    // 06:50 open closes at 06:55 -> asia
    expect(sessionOfCandleClose(atUtcHour(6) + 50 * 60 * 1000, intervalToMs('5m'))).toBe('asia');
  });
});

describe('isSessionMeaningful', () => {
  it('is true for intraday intervals up to 1h', () => {
    expect(isSessionMeaningful('1m')).toBe(true);
    expect(isSessionMeaningful('5m')).toBe(true);
    expect(isSessionMeaningful('15m')).toBe(true);
    expect(isSessionMeaningful('1h')).toBe(true);
  });

  it('is false for 4h and 1d', () => {
    expect(isSessionMeaningful('4h')).toBe(false);
    expect(isSessionMeaningful('1d')).toBe(false);
  });

  it('throws for unknown intervals', () => {
    expect(() => isSessionMeaningful('2h')).toThrow('Unknown interval: 2h');
  });
});
