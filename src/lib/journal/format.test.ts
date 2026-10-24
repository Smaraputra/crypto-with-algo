import { describe, it, expect } from 'vitest';
import {
  formatDateTime,
  toLocalInputValue,
  fromLocalInputValue,
  formatHold,
} from './format';

describe('formatDateTime', () => {
  it('formats a date to "Oct 24, 2026, 14:05" style in viewer locale', () => {
    // Construct local date 2026-10-24 14:05
    const localDate = new Date(2026, 9, 24, 14, 5);
    const result = formatDateTime(localDate.toISOString());
    expect(result).toBe('Oct 24, 2026, 14:05');
  });

  it('returns "n/a" for null, undefined, or empty values', () => {
    expect(formatDateTime(null)).toBe('n/a');
    expect(formatDateTime(undefined)).toBe('n/a');
    expect(formatDateTime('')).toBe('n/a');
  });

  it('returns "n/a" for invalid date strings', () => {
    expect(formatDateTime('invalid-date')).toBe('n/a');
    expect(formatDateTime('not a date')).toBe('n/a');
  });
});

describe('toLocalInputValue and fromLocalInputValue', () => {
  it('formats local Date to YYYY-MM-DDTHH:mm', () => {
    const d = new Date(2026, 9, 24, 14, 5, 30);
    expect(toLocalInputValue(d)).toBe('2026-10-24T14:05');
  });

  it('returns empty string for invalid Date in toLocalInputValue', () => {
    expect(toLocalInputValue(new Date('invalid'))).toBe('');
  });

  it('returns null for empty or invalid input in fromLocalInputValue', () => {
    expect(fromLocalInputValue('')).toBeNull();
    expect(fromLocalInputValue('   ')).toBeNull();
    expect(fromLocalInputValue('invalid-date')).toBeNull();
  });

  it('round trip fromLocalInputValue(toLocalInputValue(d)) equals d truncated to the minute', () => {
    const d = new Date(2026, 9, 24, 14, 5, 42, 123);
    const inputValue = toLocalInputValue(d);
    const isoString = fromLocalInputValue(inputValue);

    expect(isoString).not.toBeNull();
    const truncated = new Date(d);
    truncated.setSeconds(0, 0);

    expect(isoString).toBe(truncated.toISOString());
    expect(new Date(isoString!).getTime()).toBe(truncated.getTime());
  });
});

describe('formatHold', () => {
  it('returns null when either enteredAt or exitedAt is missing', () => {
    expect(formatHold(null, '2026-10-24T12:00:00.000Z')).toBeNull();
    expect(formatHold('2026-10-24T10:00:00.000Z', null)).toBeNull();
    expect(formatHold(undefined, undefined)).toBeNull();
  });

  it('returns null when enteredAt or exitedAt is invalid', () => {
    expect(formatHold('invalid', '2026-10-24T12:00:00.000Z')).toBeNull();
    expect(formatHold('2026-10-24T10:00:00.000Z', 'invalid')).toBeNull();
  });

  it('returns null when exited is before entered', () => {
    expect(
      formatHold('2026-10-24T12:00:00.000Z', '2026-10-24T10:00:00.000Z')
    ).toBeNull();
  });

  it('returns "under 1m" for durations under 60 seconds', () => {
    expect(
      formatHold('2026-10-24T10:00:00.000Z', '2026-10-24T10:00:30.000Z')
    ).toBe('under 1m');
    expect(
      formatHold('2026-10-24T10:00:00.000Z', '2026-10-24T10:00:00.000Z')
    ).toBe('under 1m');
  });

  it('returns minutes for durations under 1 hour', () => {
    expect(
      formatHold('2026-10-24T10:00:00.000Z', '2026-10-24T10:45:00.000Z')
    ).toBe('45m');
  });

  it('returns hours and minutes for durations under 1 day with non-zero minutes', () => {
    expect(
      formatHold('2026-10-24T10:00:00.000Z', '2026-10-24T15:20:00.000Z')
    ).toBe('5h 20m');
  });

  it('drops zero minutes unit for exact hours', () => {
    expect(
      formatHold('2026-10-24T10:00:00.000Z', '2026-10-24T12:00:00.000Z')
    ).toBe('2h');
  });

  it('returns days and hours for durations of 1 day or more', () => {
    expect(
      formatHold('2026-10-20T10:00:00.000Z', '2026-10-23T14:00:00.000Z')
    ).toBe('3d 4h');
  });

  it('drops zero hours unit for exact days', () => {
    expect(
      formatHold('2026-10-20T10:00:00.000Z', '2026-10-21T10:00:00.000Z')
    ).toBe('1d');
  });
});
