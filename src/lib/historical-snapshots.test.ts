import { describe, it, expect } from 'vitest';
import { alignTimestamp, getActiveSymbols } from './historical-snapshots';
import { SIGNAL_SYMBOLS } from './signals/signal-symbols';

describe('alignTimestamp', () => {
  it('should align to 1m interval', () => {
    const timestamp = new Date('2025-01-01T12:34:56.789Z').getTime();
    const aligned = alignTimestamp(timestamp, '1m');
    const expected = new Date('2025-01-01T12:34:00.000Z').getTime();
    expect(aligned).toBe(expected);
  });

  it('should align to 15m interval', () => {
    const timestamp = new Date('2025-01-01T12:34:56.789Z').getTime();
    const aligned = alignTimestamp(timestamp, '15m');
    const expected = new Date('2025-01-01T12:30:00.000Z').getTime();
    expect(aligned).toBe(expected);
  });

  it('should align to 1h interval', () => {
    const timestamp = new Date('2025-01-01T12:34:56.789Z').getTime();
    const aligned = alignTimestamp(timestamp, '1h');
    const expected = new Date('2025-01-01T12:00:00.000Z').getTime();
    expect(aligned).toBe(expected);
  });

  it('should align to 4h interval', () => {
    const timestamp = new Date('2025-01-01T14:34:56.789Z').getTime();
    const aligned = alignTimestamp(timestamp, '4h');
    const expected = new Date('2025-01-01T12:00:00.000Z').getTime();
    expect(aligned).toBe(expected);
  });

  it('should align to 1d interval', () => {
    const timestamp = new Date('2025-01-01T14:34:56.789Z').getTime();
    const aligned = alignTimestamp(timestamp, '1d');
    const expected = new Date('2025-01-01T00:00:00.000Z').getTime();
    expect(aligned).toBe(expected);
  });

  it('should throw on unknown interval', () => {
    const timestamp = Date.now();
    expect(() => alignTimestamp(timestamp, '30m')).toThrow('Unknown interval');
  });
});

describe('getActiveSymbols', () => {
  it('returns all SIGNAL_SYMBOLS', async () => {
    const symbols = await getActiveSymbols();
    expect(symbols).toEqual([...SIGNAL_SYMBOLS]);
    expect(symbols).toHaveLength(10);
  });

  it('returns a new array (not the original reference)', async () => {
    const a = await getActiveSymbols();
    const b = await getActiveSymbols();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
