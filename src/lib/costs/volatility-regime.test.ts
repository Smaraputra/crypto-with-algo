import { describe, expect, it } from 'vitest';

import {
  REGIME_EVIDENCE,
  REGIME_TRAILING_DAYS,
  dailyRealisedVariance,
  regimeHistoryStart,
  volatilityRegime,
  type RegimeBar,
} from './volatility-regime';

const H = 3_600_000;
const DAY = 86_400_000;
const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

/** Hourly bars from `from` for `days` days; each hour's log return is `move(dayIndex, hour)`. */
function bars(from: number, days: number, move: (day: number, hour: number) => number): RegimeBar[] {
  const out: RegimeBar[] = [];
  let price = 100;
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const open = price;
      price = open * Math.exp(move(d, h));
      out.push({ openTime: from + d * DAY + h * H, open, close: price, quoteVolume: 1e6 });
    }
  }
  return out;
}

/** A calm history where day k's hourly move grows slowly with k, so every day's variance differs. */
const calm = (d: number, h: number) => (h % 2 === 0 ? 1 : -1) * 0.001 * (1 + d / 1000);

describe('dailyRealisedVariance', () => {
  it('sums the squared hourly log returns of the day, and is undefined unless all 24 hours traded', () => {
    const series = bars(utc(2026, 1, 1), 1, () => 0.01);
    const byOpen = new Map(series.map((b) => [b.openTime, b]));
    expect(dailyRealisedVariance(byOpen, utc(2026, 1, 1))).toBeCloseTo(24 * 0.0001, 12);
    byOpen.delete(utc(2026, 1, 1, 5));
    expect(dailyRealisedVariance(byOpen, utc(2026, 1, 1))).toBeNaN();
    const zeroVolume = new Map(series.map((b) => [b.openTime, { ...b, quoteVolume: b.openTime === utc(2026, 1, 1, 3) ? 0 : 1 }]));
    expect(dailyRealisedVariance(zeroVolume, utc(2026, 1, 1))).toBeNaN();
  });
});

describe('volatilityRegime', () => {
  const start = utc(2026, 1, 1);
  const days = REGIME_TRAILING_DAYS + 1;
  const now = start + days * DAY + 30 * 60_000; // 00:30 UTC the day after the last full day

  it('reads the last complete UTC day against the 180 before it: a violent day is high, a calm one is not', () => {
    const violent = bars(start, days, (d, h) => (d === days - 1 ? (h % 2 === 0 ? 0.02 : -0.02) : calm(d, h)));
    const regime = volatilityRegime(violent, now)!;
    expect(regime.day).toBe(start + (days - 1) * DAY);
    expect(regime.high).toBe(true);
    expect(regime.percentile).toBe(100);
    expect(regime.trailingDays).toBe(180);
    expect(regime.dayVolPercent).toBeCloseTo(Math.sqrt(24 * 0.0004) * 100, 9);

    const quiet = bars(start, days, (d, h) => (d === days - 1 ? 0.0001 : calm(d, h)));
    const calmRegime = volatilityRegime(quiet, now)!;
    expect(calmRegime.high).toBe(false);
    expect(calmRegime.percentile).toBe(0);
  });

  it('puts the threshold at the trailing 80th percentile, inclusive', () => {
    // Trailing variances rise with the day index, so the 80th percentile (type 7) of 180 values is at position 143.2.
    const series = bars(start, days, calm);
    const byOpen = new Map(series.map((b) => [b.openTime, b]));
    const trailing = Array.from({ length: 180 }, (_, k) => dailyRealisedVariance(byOpen, start + k * DAY)).sort((a, b) => a - b);
    const expected = trailing[143] + 0.2 * (trailing[144] - trailing[143]);
    const regime = volatilityRegime(series, now)!;
    expect(regime.thresholdVolPercent).toBeCloseTo(Math.sqrt(expected) * 100, 9);
    // The last day continues the rise, so it is the largest of all and therefore high.
    expect(regime.high).toBe(true);
  });

  it('ignores the hour still in progress and measures yesterday, not today', () => {
    const series = bars(start, days + 1, calm);
    const midToday = start + days * DAY + 10 * H + 15 * 60_000;
    const regime = volatilityRegime(series, midToday)!;
    expect(regime.day).toBe(start + (days - 1) * DAY);
  });

  it('is null when the day is incomplete or fewer than 90 trailing days are defined', () => {
    const series = bars(start, days, calm).filter((b) => b.openTime !== start + (days - 1) * DAY + 7 * H);
    expect(volatilityRegime(series, now)).toBeNull();
    const short = bars(start + 91 * DAY, days - 91, calm);
    expect(volatilityRegime(short, now)).toBeNull();
    const enough = bars(start + 90 * DAY, days - 90, calm);
    expect(volatilityRegime(enough, now)?.trailingDays).toBe(90);
  });

  it('asks for history from 180 days before the measured day', () => {
    expect(regimeHistoryStart(now)).toBe(start);
  });
});

describe('REGIME_EVIDENCE', () => {
  it('quotes the measured persistence: about three times as likely after a high day', () => {
    expect(REGIME_EVIDENCE.highAfterHigh).toBeCloseTo(0.414, 3);
    expect(REGIME_EVIDENCE.highAfterOther).toBeCloseTo(0.146, 3);
    expect(REGIME_EVIDENCE.highOnAnyDay).toBeCloseTo(0.199, 3);
    expect(REGIME_EVIDENCE.highAfterHigh / REGIME_EVIDENCE.highAfterOther).toBeGreaterThan(2.5);
  });
});
