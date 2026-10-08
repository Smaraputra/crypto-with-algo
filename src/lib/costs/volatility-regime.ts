import { quantileSorted } from './move';

/**
 * The market's volatility regime: how BTCUSDT's realised volatility over the
 * last complete UTC day ranks against its own previous 180 days. It says
 * whether tomorrow is likely to be a large-move day, never which way.
 *
 * Definitions follow the event studies phase exactly (research branch
 * `research/event-studies`, `scripts/research/event-studies.ts`, notes 4 and
 * 15): a day's realised variance is the sum of the squared log returns
 * ln(close / open) of its 24 hourly perp bars, every one present and traded;
 * "high" is at or above the 80th percentile (linear interpolation, type 7) of
 * the defined values among the 180 days before it, at least 90 of them.
 *
 * EVIDENCE (computed 2026-10-08 on the event studies export `a93d2d26403c`,
 * BTCUSDT 2022-07-01 to 2026-06-30, 1,459 days; post hoc and in-sample, not a
 * pre-registered test): after a high day the next day was also high on 121 of
 * 292 days (41.4%); after any other day on 170 of 1,167 (14.6%); every day
 * 19.9%. On 2024-07-01 to 2026-06-30 alone: 42.8% and 14.2%. Read as a
 * forecast of the next day being high, the flag's balanced accuracy is 0.643,
 * about the same as the event studies' stress flag (0.640), which is why the
 * product shows this simpler read instead. Volatility clustering is one of the
 * best documented facts about returns; nothing here is a trading signal.
 */

export const REGIME_SYMBOL = 'BTCUSDT';
export const REGIME_TRAILING_DAYS = 180;
export const REGIME_MIN_TRAILING_DAYS = 90;
export const REGIME_QUANTILE = 0.8;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The measured persistence of high days, quoted in the UI. See EVIDENCE above. */
export const REGIME_EVIDENCE = {
  symbol: REGIME_SYMBOL,
  from: '2022-07-01',
  to: '2026-06-30',
  days: 1459,
  highAfterHigh: 121 / 292,
  highAfterOther: 170 / 1167,
  highOnAnyDay: 291 / 1459,
} as const;

/** One hourly perp bar, as `PerpKline` carries it. */
export interface RegimeBar {
  openTime: number;
  open: number;
  close: number;
  /** Quote volume; a bar with none is a missing hour. */
  quoteVolume: number;
}

export interface VolatilityRegime {
  symbol: string;
  /** The UTC day measured (its 00:00), epoch ms: the last complete day. */
  day: number;
  /** That day's realised volatility, the square root of its realised variance, percent. */
  dayVolPercent: number;
  /** The 80th-percentile threshold of the trailing days, as a volatility in percent. */
  thresholdVolPercent: number;
  /** Share of the trailing days with a lower realised variance, 0 to 100. */
  percentile: number;
  /** At or above the threshold: the next day is about three times as likely to be high as after other days. */
  high: boolean;
  /** Trailing days with a defined value (at most 180). */
  trailingDays: number;
}

/** Realised variance of the UTC day starting at `dayStart`, from bars keyed by open time. NaN unless all 24 hours traded. */
export function dailyRealisedVariance(byOpen: ReadonlyMap<number, RegimeBar>, dayStart: number): number {
  let sum = 0;
  for (let h = 0; h < 24; h++) {
    const bar = byOpen.get(dayStart + h * HOUR_MS);
    if (!bar || !(bar.quoteVolume > 0) || !(bar.open > 0) || !(bar.close > 0)) return Number.NaN;
    const r = Math.log(bar.close / bar.open);
    sum += r * r;
  }
  return sum;
}

/**
 * The regime of the last UTC day that ended at or before `now`, from hourly
 * bars covering it and the 180 days before. Null when that day or too many
 * trailing days lack a complete set of traded hours.
 */
export function volatilityRegime(bars: readonly RegimeBar[], now: number, symbol = REGIME_SYMBOL): VolatilityRegime | null {
  const byOpen = new Map<number, RegimeBar>();
  for (const bar of bars) {
    if (bar.openTime + HOUR_MS <= now) byOpen.set(bar.openTime, bar);
  }
  const day = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
  const rv = dailyRealisedVariance(byOpen, day);
  if (!Number.isFinite(rv)) return null;
  const trailing: number[] = [];
  for (let back = 1; back <= REGIME_TRAILING_DAYS; back++) {
    const value = dailyRealisedVariance(byOpen, day - back * DAY_MS);
    if (Number.isFinite(value)) trailing.push(value);
  }
  if (trailing.length < REGIME_MIN_TRAILING_DAYS) return null;
  trailing.sort((a, b) => a - b);
  const threshold = quantileSorted(trailing, REGIME_QUANTILE);
  const below = trailing.filter((v) => v < rv).length;
  return {
    symbol,
    day,
    dayVolPercent: Math.sqrt(rv) * 100,
    thresholdVolPercent: Math.sqrt(threshold) * 100,
    percentile: (below / trailing.length) * 100,
    high: rv >= threshold,
    trailingDays: trailing.length,
  };
}

/** The open time of the first hourly bar the regime needs at `now`. */
export function regimeHistoryStart(now: number): number {
  const day = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
  return day - REGIME_TRAILING_DAYS * DAY_MS;
}
