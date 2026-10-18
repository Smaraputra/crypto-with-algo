import { describe, expect, it } from 'vitest';
import { latestClose } from './job-signals';

describe('latestClose', () => {
  it('maps a Wednesday to the latest Monday 00:00 UTC for 1w', () => {
    const wednesdayNoon = Date.UTC(2026, 9, 21, 12, 0);
    const expectedMonday = Date.UTC(2026, 9, 19);
    expect(latestClose(wednesdayNoon, '1w')).toBe(expectedMonday);
  });

  it('maps Monday 00:00 UTC to itself for 1w', () => {
    const mondayMidnight = Date.UTC(2026, 9, 19, 0, 0);
    expect(latestClose(mondayMidnight, '1w')).toBe(mondayMidnight);
  });

  it('maps Sunday 23:59 to the previous Monday for 1w', () => {
    const sundayNight = Date.UTC(2026, 9, 25, 23, 59);
    const expectedMonday = Date.UTC(2026, 9, 19, 0, 0);
    expect(latestClose(sundayNight, '1w')).toBe(expectedMonday);
  });

  it('leaves 8h and 1d results unchanged for the same instants', () => {
    const wednesdayNoon = Date.UTC(2026, 9, 21, 12, 0);
    expect(latestClose(wednesdayNoon, '8h')).toBe(Date.UTC(2026, 9, 21, 8, 0));
    expect(latestClose(wednesdayNoon, '1d')).toBe(Date.UTC(2026, 9, 21, 0, 0));

    const mondayMidnight = Date.UTC(2026, 9, 19, 0, 0);
    expect(latestClose(mondayMidnight, '8h')).toBe(Date.UTC(2026, 9, 19, 0, 0));
    expect(latestClose(mondayMidnight, '1d')).toBe(Date.UTC(2026, 9, 19, 0, 0));

    const sundayNight = Date.UTC(2026, 9, 25, 23, 59);
    expect(latestClose(sundayNight, '8h')).toBe(Date.UTC(2026, 9, 25, 16, 0));
    expect(latestClose(sundayNight, '1d')).toBe(Date.UTC(2026, 9, 25, 0, 0));
  });
});
