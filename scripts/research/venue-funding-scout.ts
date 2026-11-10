/**
 * CROSS-VENUE FUNDING SPREAD CENSUS. A DESCRIPTIVE scout, not a test.
 *
 * PURPOSE. Hold the same coin's perp on two venues, short where funding is
 * high and long where it is low. Both legs are perps, so there are no spot
 * fees and no borrowing. Hyperliquid pays funding every hour. This census
 * reports how often the funding spread between Binance and another venue
 * exceeds a four-leg round trip, how long it lasts, what it pays, and how often
 * one leg would be liquidated. No rule is chosen, no ledger trial is added,
 * nothing here is a result to select on. It mirrors funding-scout.ts.
 *
 * DATA DISCIPLINE (hard requirement, same as funding-scout). Nothing at or
 * after 2024-07-01 00:00 UTC is requested or kept. Every API request's end time
 * is at most SCOUT_CUTOFF_MS - 1 (`assertEndAllowed`, called by every request
 * builder). Every archive month goes through `monthsBetween` or
 * `assertMonthAllowed` from ./funding-scout, which throw after 2024-06. Rows at
 * or after the cutoff are dropped by every parser.
 *
 * VENUES.
 *   Binance (base)  funding from the archive exactly as funding-scout reads it
 *                   (fetchArchiveFile + parseFundingCsv + normaliseSettlements).
 *                   Premium from archive premiumIndex 1h klines (the close is
 *                   the premium). Price path from archive perp 1h klines.
 *   Hyperliquid     POST /info {"type":"meta"} for the coin list and
 *                   {"type":"fundingHistory"} for hourly funding (rate PAID that
 *                   hour, and the hour's average premium against the oracle).
 *                   History starts 2023-05-12. Sequential requests, at least
 *                   2,500 ms apart.
 *   Bybit           v5 linear funding history (paged backward), premium index
 *                   1h klines (fetched for the months an episode touches only)
 *                   and instruments-info. Sequential requests, at least 150 ms
 *                   apart. Bybit's instrument list holds only CURRENT
 *                   instruments, so Bybit coverage is NOT survivorship-free.
 *   On HTTP 429 or 5xx the request backs off 10 s, 20 s, 40 s, then the coin is
 *   recorded as an error and the run continues. A Bybit retCode other than 0 is
 *   an error for that request.
 *
 * FEE SOURCES (VENUE_COSTS). Binance USDT-M VIP 0 maker 2 bps, taker 5 bps
 * (owner's fills, 2026-02). Hyperliquid base tier taker 0.045%, maker 0.015%
 * (docs, fetched 2026-11-10). Bybit VIP 0 linear taker 0.055%, maker 0.02%
 * (ASSUMED, UNVERIFIED). Taker slippage is 3 bps per leg; the +10bps profile
 * adds 10 bps per leg.
 *
 * EPISODE RULES. The spread at an hour-aligned decision time T is
 * (sum of the other venue's funding rates paid in (T-24h, T]) minus (the same
 * for Binance). It is positive when the other venue pays more per day, which
 * means: SHORT the other venue, LONG Binance (sign +1). Sign -1 is the reverse.
 *   start  at T when |spread(T)| >= level and |spread(T - 1h)| < level (or T is
 *          the first decision time), with no episode open.
 *   exit   at the first later T' with sign x spread(T') <= 0. An episode with no
 *          exit is truncated at the last decision time and excluded from every
 *          statistic. The next episode can start at the exit hour's successor at
 *          the earliest. Threshold comparisons carry a 1e-12 tolerance so a
 *          spread that is exactly at the level in decimal arithmetic is not
 *          lost to floating-point drift.
 *
 * MEASUREMENT. grossFunding = sign x (other rates - Binance rates) over events
 * with entryT < t <= exitT. basisApprox = -sign x [(otherPrem - basePrem)(exitT)
 * - (otherPrem - basePrem)(entryT)], an approximation from premium indices, not
 * from traded prices. Net = grossFunding + (basisApprox or 0) - 2 x perSide. A
 * missing premium gives status 'no-premium' and a net WITHOUT basis. Liquidation
 * uses the Binance perp path from the entry close; each leg is margined
 * separately, so the worst of the up and down move is tested for each leverage.
 *
 * RESULT, 2026-11-10. Universe `21924712` (as funding-scout.ts). Run from the
 * branch's code in `crypto-ops:forward-monthly` on the VPS, reports in
 * `~/funding-scout/out/`: `venue-hyperliquid.json` (file sha256
 * `350074262c97`, body `5c201cf77221`) and `venue-bybit.json` (file
 * `20e03e9981b3`, body `bf60290d5429`). 0 errors on either venue. Descriptive:
 * no trial is added, the ledger stays at 2,422.
 *
 *   Hyperliquid (135 coins matched, history 2023-05-12 to 2024-06-30), per
 *   episode over ok and no-premium episodes (n), taker cost 0.155% a side:
 *   level/day  n      coins  hold med  gross med  basis med  net mean  net med  net>0  maker med  stress med  liq 3x
 *   0.10%      2,049  120    72h       +0.22%     +0.09%     +0.49%    +0.04%   53%    +0.28%     -0.36%      12.9%
 *   0.20%        983  114    87h       +0.48%     +0.13%     +0.84%    +0.37%   71%    +0.61%     -0.03%      16.5%
 *   0.50%        182   62    48h       +0.45%     +0.17%     +0.51%    +0.32%   59%    +0.56%     -0.08%      21.4%
 *   Mean net taker by entry half-year at 0.20%: 2023H1 +2.75% (37), 2023H2
 *   +0.90% (422), 2024H1 +0.65% (515): positive in each, and falling.
 *   Fixed-slot read (K slots first come first served, capital 2 per unit of
 *   notional, each leg at 1x on its own venue), annual on capital:
 *     0.10%  K 5 +10.8% (slot use 94%), K 10 +12.0% (92%), K 20 +11.3% (84%)
 *     0.20%  K 5 +16.3% (82%),          K 10 +15.5% (72%), K 20 +12.1% (56%)
 *     0.50%  K 5  +5.9% (30%),          K 10  +3.3% (19%), K 20  +2.0% (10%)
 *   Maker on all four legs adds 3.5 to 7 points at 0.10% and 0.20%.
 *
 *   Bybit (196 coins matched, CURRENT instruments only, so not survivorship
 *   free, 2020-01 to 2024-06): mean net taker +0.02% to +0.24% per episode,
 *   median negative at every level (-0.18%, -0.08%, -0.11%), the fixed-slot
 *   read -0.3% to +3.2% a year on capital at taker and +0.7% to +7.7% at
 *   maker. Two large venues that arbitrage each other leave little.
 *
 * READING. Binance and Bybit funding stay close, as two liquid centralised
 * venues should. Hyperliquid's funding ran persistently above Binance's on
 * many coins over its first 13 months, and a spread position collecting the
 * difference every hour paid at the scale the owner asked about (a median
 * 0.20%-level episode nets about +0.37% over 87h, collected as dozens of
 * hourly payments). It is the only idea in this scout with a capital-limited
 * return clearly above a savings yield in the scouting window, and it is
 * positive in each half-year. The caveats decide whether it is real:
 *   (1) the window is short and early (Hyperliquid's first year, including its
 *       points season from late 2023), and the edge shrinks across it;
 *   (2) the price leg is approximated from premium indices, not traded
 *       prices, and Hyperliquid's premium is an hourly average;
 *   (3) it is slippage-sensitive: 10 bps more per leg turns the median to
 *       about zero;
 *   (4) each leg is margined on its own venue, so a 3x leg would have been
 *       liquidated in 13% to 21% of episodes, and the book needs both venues
 *       funded (Hyperliquid custody, USDC bridging, venue risk).
 * The reserved span 2024-07-01 to 2026-06-30 has never been read by this
 * scout, so a frozen rule can be judged on it once, out of sample.
 *
 * Usage:
 *   npx tsx scripts/research/venue-funding-scout.ts --venue hyperliquid|bybit \
 *     --universe <universe-source.json> --cache <dir> --out <report.json> [--coins A,B]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  fetchArchiveFile,
  parseFundingCsv,
  parseKlineCsv,
  type FundingCsvRow,
  type KlineCsvRow,
} from '@/lib/external/binance-archive';
import { settlementTimeOf } from '@/lib/funding-settlements';

import { HOUR_MS, MAINTENANCE_MARGIN } from './carry-sim';
import {
  SCOUT_CUTOFF_MS,
  SCOUT_FROM_MS,
  SCOUT_LAST_MONTH,
  SCOUT_LEVERAGES,
  assertMonthAllowed,
  monthsBetween,
  normaliseSettlements,
  quantile,
  type Dist,
  type NetSummary,
} from './funding-scout';
import { assetKey, type UniverseFolder, type UniverseSource } from './universe-source';

export type Venue = 'hyperliquid' | 'bybit';
export const VENUES: Venue[] = ['hyperliquid', 'bybit'];

/** Trailing 24h funding difference: 0.1%, 0.2%, 0.5% per day. */
export const SPREAD_LEVELS = [0.001, 0.002, 0.005];

export interface VenueCost {
  name: string;
  perSide: number;
}

export const VENUE_COSTS: Record<Venue, VenueCost[]> = {
  // perSide = cost of BOTH legs for one side (entry or exit): Binance leg + other leg, slippage 3 bps per leg on taker.
  hyperliquid: [
    { name: 'taker', perSide: 0.0005 + 0.00045 + 2 * 0.0003 },
    { name: 'maker', perSide: 0.0002 + 0.00015 },
    { name: 'taker+10bps', perSide: 0.0005 + 0.00045 + 2 * 0.0013 },
  ],
  bybit: [
    { name: 'taker', perSide: 0.0005 + 0.00055 + 2 * 0.0003 },
    { name: 'maker', perSide: 0.0002 + 0.0002 },
    { name: 'taker+10bps', perSide: 0.0005 + 0.00055 + 2 * 0.0013 },
  ],
};

const TAKER = 'taker';
const MAKER = 'maker';
/** Tolerance on threshold comparisons (see EPISODE RULES). */
const EPS = 1e-12;

const HYPERLIQUID_URL = 'https://api.hyperliquid.xyz/info';
const BYBIT_URL = 'https://api.bybit.com';
const BYBIT_FUNDING_PAGE = 200;
const BACKOFF_MS = [10_000, 20_000, 40_000];
const MIN_GAP_MS: Record<Venue, number> = { hyperliquid: 2_500, bybit: 150 };

// ---------------------------------------------------------------------------
// Data discipline for API requests
// ---------------------------------------------------------------------------

/** Throws unless a request's end time is at most SCOUT_CUTOFF_MS - 1. Every request builder calls it. */
export function assertEndAllowed(endMs: number): void {
  if (!Number.isFinite(endMs) || endMs >= SCOUT_CUTOFF_MS) {
    throw new Error(`data discipline: request end ${endMs} is at or after ${SCOUT_CUTOFF_MS}`);
  }
}

export function hyperliquidFundingBody(
  coin: string,
  startTime: number,
  endTime: number
): { type: 'fundingHistory'; coin: string; startTime: number; endTime: number } {
  assertEndAllowed(endTime);
  return { type: 'fundingHistory', coin, startTime, endTime };
}

export function bybitFundingUrl(symbol: string, startTime: number, endTime: number): string {
  assertEndAllowed(endTime);
  const q = new URLSearchParams({
    category: 'linear',
    symbol,
    startTime: String(startTime),
    endTime: String(endTime),
    limit: String(BYBIT_FUNDING_PAGE),
  });
  return `${BYBIT_URL}/v5/market/funding/history?${q.toString()}`;
}

export function bybitPremiumUrl(symbol: string, start: number, end: number): string {
  assertEndAllowed(end);
  const q = new URLSearchParams({
    category: 'linear',
    symbol,
    interval: '60',
    start: String(start),
    end: String(end),
    limit: '1000',
  });
  return `${BYBIT_URL}/v5/market/premium-index-price-kline?${q.toString()}`;
}

export function bybitInstrumentsUrl(cursor: string | null): string {
  const q = new URLSearchParams({ category: 'linear', limit: '1000' });
  if (cursor) q.set('cursor', cursor);
  return `${BYBIT_URL}/v5/market/instruments-info?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Funding events and the trailing sum
// ---------------------------------------------------------------------------

export interface FundingEvent {
  t: number;
  rate: number;
}

/** Sum of `rate` over events with at - hours x HOUR_MS < t <= at. Events are sorted ascending. */
export function trailingSum(events: readonly FundingEvent[], at: number, hours = 24): number {
  const lo = at - hours * HOUR_MS;
  let sum = 0;
  for (const event of events) {
    if (event.t > at) break;
    if (event.t > lo) sum += event.rate;
  }
  return sum;
}

/** A trailing window over sorted events for non-decreasing queries; sums in ascending order like trailingSum. */
class TrailingWindow {
  private lo = 0;
  private hi = 0;

  constructor(private readonly events: readonly FundingEvent[]) {}

  at(time: number, hours = 24): number {
    const floor = time - hours * HOUR_MS;
    while (this.hi < this.events.length && this.events[this.hi].t <= time) this.hi++;
    while (this.lo < this.hi && this.events[this.lo].t <= floor) this.lo++;
    let sum = 0;
    for (let i = this.lo; i < this.hi; i++) sum += this.events[i].rate;
    return sum;
  }
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface SpreadEpisode {
  level: number;
  sign: 1 | -1;
  entryT: number;
  exitT: number;
  truncated: boolean;
}

/**
 * The decision-time window shared by two series: from the later first event
 * plus 24h (rounded up to the hour) to the earlier last event. Null when either
 * series is empty or the window is empty.
 */
export function scanWindow(
  base: readonly FundingEvent[],
  other: readonly FundingEvent[]
): { fromT: number; toT: number } | null {
  if (base.length === 0 || other.length === 0) return null;
  const first = Math.max(base[0].t, other[0].t) + 24 * HOUR_MS;
  const fromT = Math.ceil(first / HOUR_MS) * HOUR_MS;
  const toT = Math.min(base[base.length - 1].t, other[other.length - 1].t);
  return fromT > toT ? null : { fromT, toT };
}

export function detectSpreadEpisodes(
  base: readonly FundingEvent[],
  other: readonly FundingEvent[],
  level: number,
  fromT: number,
  toT: number
): SpreadEpisode[] {
  const episodes: SpreadEpisode[] = [];
  const baseWindow = new TrailingWindow(base);
  const otherWindow = new TrailingWindow(other);
  let open: { sign: 1 | -1; entryT: number } | null = null;
  let previous: number | null = null;
  let lastT = fromT;

  for (let time = fromT; time <= toT; time += HOUR_MS) {
    lastT = time;
    const spread = otherWindow.at(time) - baseWindow.at(time);
    if (open !== null) {
      if (open.sign * spread <= EPS) {
        episodes.push({ level, sign: open.sign, entryT: open.entryT, exitT: time, truncated: false });
        open = null;
      }
    } else if (Math.abs(spread) >= level - EPS && (previous === null || Math.abs(previous) < level - EPS)) {
      open = { sign: spread > 0 ? 1 : -1, entryT: time };
    }
    previous = spread;
  }
  if (open !== null) {
    episodes.push({ level, sign: open.sign, entryT: open.entryT, exitT: lastT, truncated: true });
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type SpreadStatus = 'ok' | 'no-premium' | 'gap' | 'empty';

export interface SpreadMeasure {
  status: SpreadStatus;
  missingBars: number;
  grossFunding: number | null;
  basisApprox: number | null;
  upMove: number | null;
  downMove: number | null;
  worstLeg: number | null;
  liquidated: Record<string, boolean> | null;
  holdHours: number | null;
  otherEventsCollected: number | null;
  baseEventsCollected: number | null;
  net: Record<string, number> | null;
}

function nullSpreadMeasure(status: SpreadStatus, missingBars = 0): SpreadMeasure {
  return {
    status,
    missingBars,
    grossFunding: null,
    basisApprox: null,
    upMove: null,
    downMove: null,
    worstLeg: null,
    liquidated: null,
    holdHours: null,
    otherEventsCollected: null,
    baseEventsCollected: null,
    net: null,
  };
}

/**
 * Premium maps are keyed by hour. Binance and Bybit maps are keyed by the 1h
 * bar OPEN (the premium at decision time T is the close of the bar opening at
 * T - 1h). The Hyperliquid map is keyed by the event's rounded time (the
 * premium at T is the event at T), so `venue` selects the other map's lookup.
 * `perp` is keyed by Binance 1h bar open.
 */
export function measureSpreadEpisode(
  ep: SpreadEpisode,
  base: readonly FundingEvent[],
  other: readonly FundingEvent[],
  basePremium: ReadonlyMap<number, number>,
  otherPremium: ReadonlyMap<number, number>,
  perp: ReadonlyMap<number, KlineCsvRow>,
  costs: readonly VenueCost[],
  venue: Venue
): SpreadMeasure {
  if (ep.exitT <= ep.entryT) return nullSpreadMeasure('empty');

  const opens: number[] = [];
  for (let open = ep.entryT - HOUR_MS; open <= ep.exitT - HOUR_MS; open += HOUR_MS) opens.push(open);
  let missingBars = 0;
  for (const open of opens) if (!perp.has(open)) missingBars++;
  if (missingBars > 0) return nullSpreadMeasure('gap', missingBars);

  let otherSum = 0;
  let baseSum = 0;
  let otherEventsCollected = 0;
  let baseEventsCollected = 0;
  for (const event of other) {
    if (event.t > ep.entryT && event.t <= ep.exitT) {
      otherSum += event.rate;
      otherEventsCollected++;
    }
  }
  for (const event of base) {
    if (event.t > ep.entryT && event.t <= ep.exitT) {
      baseSum += event.rate;
      baseEventsCollected++;
    }
  }
  const grossFunding = ep.sign * (otherSum - baseSum);

  const baseAt = (time: number): number | undefined => basePremium.get(time - HOUR_MS);
  const otherAt = (time: number): number | undefined =>
    otherPremium.get(venue === 'hyperliquid' ? time : time - HOUR_MS);
  const pe = otherAt(ep.entryT);
  const px = otherAt(ep.exitT);
  const be = baseAt(ep.entryT);
  const bx = baseAt(ep.exitT);
  const basisApprox =
    pe === undefined || px === undefined || be === undefined || bx === undefined
      ? null
      : -ep.sign * (px - bx - (pe - be));

  const entryClose = perp.get(opens[0])!.close;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (let i = 1; i < opens.length; i++) {
    const bar = perp.get(opens[i])!;
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
  }
  const upMove = high / entryClose - 1;
  const downMove = 1 - low / entryClose;
  const worstLeg = Math.max(upMove, downMove);
  const liquidated: Record<string, boolean> = {};
  for (const leverage of SCOUT_LEVERAGES) {
    liquidated[`${leverage}x`] = worstLeg >= 1 / leverage - MAINTENANCE_MARGIN;
  }

  const net: Record<string, number> = {};
  for (const cost of costs) net[cost.name] = grossFunding + (basisApprox ?? 0) - 2 * cost.perSide;

  return {
    status: basisApprox === null ? 'no-premium' : 'ok',
    missingBars: 0,
    grossFunding,
    basisApprox,
    upMove,
    downMove,
    worstLeg,
    liquidated,
    holdHours: (ep.exitT - ep.entryT) / HOUR_MS,
    otherEventsCollected,
    baseEventsCollected,
    net,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type MeasuredSpreadEpisode = SpreadEpisode & SpreadMeasure & { symbol: string };

export interface SpreadSummary {
  venue: Venue;
  level: number;
  counts: { total: number; ok: number; noPremium: number; gap: number; empty: number; truncated: number };
  /** Included episodes (not truncated, 'ok' or 'no-premium') whose net excludes basis. */
  noPremium: number;
  distinctSymbols: number;
  grossFunding: Dist;
  basisApprox: Dist;
  holdHours: Dist;
  net: Record<string, NetSummary>;
  liquidationShare: Record<string, number | null>;
  byYear: Record<string, { n: number; meanNetTaker: number; sumNetTaker: number }>;
  top10Share: number | null;
}

function distOf(values: readonly number[]): Dist {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length,
    median: quantile(sorted, 0.5),
    p10: quantile(sorted, 0.1),
    p90: quantile(sorted, 0.9),
  };
}

export function summariseSpread(venue: Venue, level: number, episodes: MeasuredSpreadEpisode[]): SpreadSummary {
  const counts = { total: episodes.length, ok: 0, noPremium: 0, gap: 0, empty: 0, truncated: 0 };
  const included: MeasuredSpreadEpisode[] = [];
  for (const ep of episodes) {
    if (ep.truncated) counts.truncated++;
    else if (ep.status === 'ok') {
      counts.ok++;
      included.push(ep);
    } else if (ep.status === 'no-premium') {
      counts.noPremium++;
      included.push(ep);
    } else if (ep.status === 'gap') counts.gap++;
    else counts.empty++;
  }

  const take = (pick: (ep: MeasuredSpreadEpisode) => number | null): number[] =>
    included.map(pick).filter((v): v is number => v !== null);

  const net: Record<string, NetSummary> = {};
  for (const cost of VENUE_COSTS[venue]) {
    const values = take((ep) => ep.net?.[cost.name] ?? null);
    net[cost.name] = {
      ...distOf(values),
      shareNetPositive: values.length === 0 ? null : values.filter((v) => v > 0).length / values.length,
    };
  }

  const liquidationShare: Record<string, number | null> = {};
  for (const leverage of SCOUT_LEVERAGES) {
    const key = `${leverage}x`;
    liquidationShare[key] =
      included.length === 0 ? null : included.filter((ep) => ep.liquidated?.[key] === true).length / included.length;
  }

  const takerNets = included.map((ep) => ep.net?.[TAKER] ?? 0);
  const byYear: SpreadSummary['byYear'] = {};
  included.forEach((ep, i) => {
    const year = String(new Date(ep.entryT).getUTCFullYear());
    const entry = byYear[year] ?? { n: 0, meanNetTaker: 0, sumNetTaker: 0 };
    entry.n++;
    entry.sumNetTaker += takerNets[i];
    entry.meanNetTaker = entry.sumNetTaker / entry.n;
    byYear[year] = entry;
  });

  const total = takerNets.reduce((a, b) => a + b, 0);
  const top10 = [...takerNets]
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((a, b) => a + b, 0);

  return {
    venue,
    level,
    counts,
    noPremium: counts.noPremium,
    distinctSymbols: new Set(included.map((ep) => ep.symbol)).size,
    grossFunding: distOf(take((ep) => ep.grossFunding)),
    basisApprox: distOf(take((ep) => ep.basisApprox)),
    holdHours: distOf(take((ep) => ep.holdHours)),
    net,
    liquidationShare,
    byYear,
    top10Share: total <= 0 ? null : top10 / total,
  };
}

// ---------------------------------------------------------------------------
// Parsers (no network)
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/** Stable sort ascending by `t`; among rows sharing an hour the last one in INPUT order is kept. */
function dedupeByHour<T extends { t: number }>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const unique: T[] = [];
  for (const row of sorted) {
    if (unique.length > 0 && unique[unique.length - 1].t === row.t) unique[unique.length - 1] = row;
    else unique.push(row);
  }
  return unique;
}

export function parseHyperliquidFunding(json: unknown): Array<{ t: number; rate: number; premium: number }> {
  if (!Array.isArray(json)) throw new Error('hyperliquid fundingHistory: expected an array');
  const rows: Array<{ t: number; rate: number; premium: number }> = [];
  for (const item of json) {
    const r = asRecord(item, 'hyperliquid fundingHistory row');
    const time = toNum(r.time);
    const rate = toNum(r.fundingRate);
    const premium = toNum(r.premium);
    if (!Number.isFinite(time) || !Number.isFinite(rate) || !Number.isFinite(premium)) continue;
    const t = settlementTimeOf(time);
    if (t >= SCOUT_CUTOFF_MS) continue;
    rows.push({ t, rate, premium });
  }
  return dedupeByHour(rows);
}

/** The `result.list` of a Bybit response. Throws on retCode !== 0. */
export function bybitList(json: unknown): unknown[] {
  const r = asRecord(json, 'bybit response');
  if (r.retCode !== 0) throw new Error(`bybit retCode ${String(r.retCode)}: ${String(r.retMsg ?? '')}`);
  const result = asRecord(r.result, 'bybit result');
  if (!Array.isArray(result.list)) throw new Error('bybit result.list: expected an array');
  return result.list;
}

/** Raw (unrounded, uncut) Bybit funding rows, in response order. Used by the pager. */
export function bybitRawFunding(json: unknown): Array<{ time: number; rate: number }> {
  const rows: Array<{ time: number; rate: number }> = [];
  for (const item of bybitList(json)) {
    const r = asRecord(item, 'bybit funding row');
    const time = toNum(r.fundingRateTimestamp);
    const rate = toNum(r.fundingRate);
    if (Number.isFinite(time) && Number.isFinite(rate)) rows.push({ time, rate });
  }
  return rows;
}

export function parseBybitFunding(json: unknown): FundingEvent[] {
  const rows: FundingEvent[] = [];
  for (const { time, rate } of bybitRawFunding(json)) {
    const t = settlementTimeOf(time);
    if (t >= SCOUT_CUTOFF_MS) continue;
    rows.push({ t, rate });
  }
  return dedupeByHour(rows);
}

/** Bybit premium index klines, newest first: [startTime, open, high, low, close]. Keys the bar open to its close. */
export function parseBybitPremium(json: unknown): Map<number, number> {
  const map = new Map<number, number>();
  for (const item of bybitList(json)) {
    if (!Array.isArray(item)) throw new Error('bybit premium row: expected an array');
    const open = toNum(item[0]);
    const close = toNum(item[4]);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    if (open >= SCOUT_CUTOFF_MS) continue;
    map.set(open, close);
  }
  return map;
}

/** Hyperliquid meta: the coin names, delisted entries included (their history is still served). */
export function parseHyperliquidMeta(json: unknown): string[] {
  const r = asRecord(json, 'hyperliquid meta');
  if (!Array.isArray(r.universe)) throw new Error('hyperliquid meta.universe: expected an array');
  const names: string[] = [];
  for (const item of r.universe) {
    const entry = asRecord(item, 'hyperliquid meta entry');
    if (typeof entry.name === 'string' && entry.name !== '') names.push(entry.name);
  }
  return names;
}

/** One instruments-info page: current USDT linear perpetuals and the next cursor ('' when done). */
export function parseBybitInstruments(json: unknown): { symbols: string[]; nextCursor: string } {
  const symbols: string[] = [];
  for (const item of bybitList(json)) {
    const entry = asRecord(item, 'bybit instrument');
    if (
      typeof entry.symbol === 'string' &&
      entry.quoteCoin === 'USDT' &&
      entry.contractType === 'LinearPerpetual'
    ) {
      symbols.push(entry.symbol);
    }
  }
  const result = asRecord(asRecord(json, 'bybit response').result, 'bybit result');
  return { symbols, nextCursor: typeof result.nextPageCursor === 'string' ? result.nextPageCursor : '' };
}

// ---------------------------------------------------------------------------
// Coin mapping (Binance folder to venue symbol)
// ---------------------------------------------------------------------------

/** assetKey(folder), prefixed with 'k' when the folder starts with 1000 (and not 1000000). Null when not listed. */
export function hyperliquidCoinFor(folder: string, listed: ReadonlySet<string>): string | null {
  const key = assetKey(folder);
  const coin = folder.startsWith('1000') && !folder.startsWith('1000000') ? `k${key}` : key;
  return listed.has(coin) ? coin : null;
}

/** The folder name if listed, else for a 1000-prefixed folder `<assetKey>1000USDT` if listed, else null. */
export function bybitSymbolFor(folder: string, listed: ReadonlySet<string>): string | null {
  if (listed.has(folder)) return folder;
  if (folder.startsWith('1000')) {
    const alternative = `${assetKey(folder)}1000USDT`;
    if (listed.has(alternative)) return alternative;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface VenueScoutArgs {
  venue: Venue;
  universe: string;
  cache: string;
  out: string;
  coins: string[] | null;
}

export function parseArgs(argv: string[]): VenueScoutArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const key = flag.slice(2);
    if (!['venue', 'universe', 'cache', 'out', 'coins'].includes(key)) throw new Error(`Unknown flag ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    flags.set(key, value);
    i++;
  }
  for (const required of ['venue', 'universe', 'cache', 'out']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }
  const venue = flags.get('venue')!;
  if (venue !== 'hyperliquid' && venue !== 'bybit') throw new Error('--venue must be hyperliquid or bybit');
  return {
    venue,
    universe: flags.get('universe')!,
    cache: flags.get('cache')!,
    out: flags.get('out')!,
    coins: flags.has('coins')
      ? flags
          .get('coins')!
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Filesystem-safe file name part. */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Sequential, throttled JSON client with a one-file-per-request cache. A cached
 * response makes no network call and does not count against the throttle.
 */
class ApiClient {
  private lastRequestAt = 0;

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly minGapMs: number
  ) {}

  async getJson(
    cacheFile: string,
    url: string,
    init?: RequestInit,
    validate: (json: unknown) => void = () => undefined
  ): Promise<unknown> {
    if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as unknown;

    let lastError: Error = new Error('request failed');
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      const wait = this.lastRequestAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      let retry = false;
      try {
        const res = await this.fetchFn(url, init);
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`HTTP ${res.status}`);
          retry = true;
        } else if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        } else {
          const json = (await res.json()) as unknown;
          validate(json);
          mkdirSync(dirname(cacheFile), { recursive: true });
          writeFileSync(cacheFile, JSON.stringify(json));
          return json;
        }
      } catch (error) {
        // A thrown fetch (network) is retried like a 5xx; any other error is final.
        if (error instanceof TypeError) {
          lastError = error;
          retry = true;
        } else {
          throw error;
        }
      }
      if (retry && attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
    throw lastError;
  }
}

/** Lazily loads whole months of Binance archive 1h klines for one (dataset, symbol). */
class ArchiveKlineStore {
  readonly bars = new Map<number, KlineCsvRow>();
  readonly closes = new Map<number, number>();
  private readonly months = new Set<string>();

  constructor(
    private readonly dataset: 'klines' | 'premiumIndex',
    private readonly symbol: string,
    private readonly cacheDir: string
  ) {}

  async ensure(month: string): Promise<void> {
    assertMonthAllowed(month);
    if (this.months.has(month)) return;
    this.months.add(month);
    const csv = await fetchArchiveFile(
      { dataset: this.dataset, symbol: this.symbol, interval: '1h', date: month },
      { cacheDir: this.cacheDir }
    );
    if (csv === null) return;
    for (const row of parseKlineCsv(csv)) {
      if (row.timestamp >= SCOUT_CUTOFF_MS) continue;
      this.bars.set(row.timestamp, row);
      this.closes.set(row.timestamp, row.close);
    }
  }
}

/** Lazily loads whole months of Bybit premium index 1h klines for one symbol. */
class BybitPremiumStore {
  readonly closes = new Map<number, number>();
  private readonly months = new Set<string>();

  constructor(
    private readonly symbol: string,
    private readonly client: ApiClient,
    private readonly cacheRoot: string
  ) {}

  async ensure(month: string): Promise<void> {
    assertMonthAllowed(month);
    if (this.months.has(month)) return;
    this.months.add(month);
    const [year, mon] = month.split('-').map(Number);
    const start = Date.UTC(year, mon - 1, 1);
    const end = Date.UTC(year, mon, 1) - 1;
    const url = bybitPremiumUrl(this.symbol, start, end);
    const json = await this.client.getJson(
      join(this.cacheRoot, 'bybit', 'premium', safeName(this.symbol), `${month}.json`),
      url,
      undefined,
      bybitList
    );
    for (const [open, close] of parseBybitPremium(json)) this.closes.set(open, close);
  }
}

async function loadHyperliquidCoins(client: ApiClient, cacheRoot: string): Promise<Set<string>> {
  const json = await client.getJson(
    join(cacheRoot, 'hyperliquid', 'meta.json'),
    HYPERLIQUID_URL,
    postInit({ type: 'meta' })
  );
  return new Set(parseHyperliquidMeta(json));
}

async function loadBybitSymbols(client: ApiClient, cacheRoot: string): Promise<Set<string>> {
  const symbols = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const url = bybitInstrumentsUrl(cursor);
    const json = await client.getJson(
      join(cacheRoot, 'bybit', 'instruments', `${page}.json`),
      url,
      undefined,
      bybitList
    );
    const parsed = parseBybitInstruments(json);
    for (const symbol of parsed.symbols) symbols.add(symbol);
    if (parsed.nextCursor === '') break;
    cursor = parsed.nextCursor;
  }
  return symbols;
}

/** Pages Hyperliquid fundingHistory forward from the window start; returns the combined raw rows. */
async function fetchHyperliquidFunding(coin: string, client: ApiClient, cacheRoot: string): Promise<unknown[]> {
  const end = SCOUT_CUTOFF_MS - 1;
  const all: unknown[] = [];
  let start = SCOUT_FROM_MS;
  for (;;) {
    const body = hyperliquidFundingBody(coin, start, end);
    const json = await client.getJson(
      join(cacheRoot, 'hyperliquid', 'funding', safeName(coin), `${start}-${end}.json`),
      HYPERLIQUID_URL,
      postInit(body)
    );
    if (!Array.isArray(json)) throw new Error('hyperliquid fundingHistory: expected an array');
    if (json.length === 0) break;
    all.push(...json);
    const lastTime = toNum(asRecord(json[json.length - 1], 'hyperliquid fundingHistory row').time);
    if (!Number.isFinite(lastTime)) throw new Error('hyperliquid fundingHistory: last row has no time');
    // The request end is capped at the cutoff, so a page that reaches the last hour needs no follow-up.
    if (lastTime >= SCOUT_CUTOFF_MS - HOUR_MS) break;
    start = lastTime + 1;
    if (start > end) break;
  }
  return all;
}

/** Pages Bybit funding history backward from the cutoff to 2020-01-01; returns a combined response. */
async function fetchBybitFunding(symbol: string, client: ApiClient, cacheRoot: string): Promise<unknown> {
  const list: unknown[] = [];
  let end = SCOUT_CUTOFF_MS - 1;
  for (;;) {
    const url = bybitFundingUrl(symbol, SCOUT_FROM_MS, end);
    const json = await client.getJson(
      join(cacheRoot, 'bybit', 'funding', safeName(symbol), `${SCOUT_FROM_MS}-${end}.json`),
      url,
      undefined,
      bybitList
    );
    const raw = bybitRawFunding(json);
    if (raw.length === 0) break;
    list.push(...bybitList(json));
    const oldest = Math.min(...raw.map((row) => row.time));
    if (oldest <= SCOUT_FROM_MS) break;
    end = oldest - 1;
  }
  return { retCode: 0, result: { list } };
}

interface CoinResult {
  folder: string;
  venueSymbol: string;
  baseEvents: number;
  otherEvents: number;
  episodes: MeasuredSpreadEpisode[];
}

interface ScoutContext {
  venue: Venue;
  cacheRoot: string;
  client: ApiClient;
}

async function scoutCoin(folder: UniverseFolder, venueSymbol: string, ctx: ScoutContext): Promise<CoinResult> {
  const archiveCache = join(ctx.cacheRoot, 'archive');

  // Venue funding first, then Binance funding.
  let other: FundingEvent[];
  const hyperliquidPremium = new Map<number, number>();
  if (ctx.venue === 'hyperliquid') {
    const rows = parseHyperliquidFunding(await fetchHyperliquidFunding(venueSymbol, ctx.client, ctx.cacheRoot));
    other = rows.map((row) => ({ t: row.t, rate: row.rate }));
    for (const row of rows) hyperliquidPremium.set(row.t, row.premium);
  } else {
    other = parseBybitFunding(await fetchBybitFunding(venueSymbol, ctx.client, ctx.cacheRoot));
  }

  const rows: FundingCsvRow[] = [];
  for (const month of folder.fundingMonths.filter((m) => m <= SCOUT_LAST_MONTH)) {
    assertMonthAllowed(month);
    const csv = await fetchArchiveFile({ dataset: 'fundingRate', symbol: folder.name, date: month }, { cacheDir: archiveCache });
    if (csv !== null) rows.push(...parseFundingCsv(csv));
  }
  const base: FundingEvent[] = normaliseSettlements(rows).map((s) => ({ t: s.t, rate: s.rate }));

  const result: CoinResult = {
    folder: folder.name,
    venueSymbol,
    baseEvents: base.length,
    otherEvents: other.length,
    episodes: [],
  };
  const window = scanWindow(base, other);
  if (window === null) return result;

  const perpStore = new ArchiveKlineStore('klines', folder.name, archiveCache);
  const premiumStore = new ArchiveKlineStore('premiumIndex', folder.name, archiveCache);
  const bybitPremium = ctx.venue === 'bybit' ? new BybitPremiumStore(venueSymbol, ctx.client, ctx.cacheRoot) : null;
  const otherPremium = bybitPremium !== null ? bybitPremium.closes : hyperliquidPremium;

  for (const level of SPREAD_LEVELS) {
    for (const ep of detectSpreadEpisodes(base, other, level, window.fromT, window.toT)) {
      const months = monthsBetween(ep.entryT - HOUR_MS, ep.exitT);
      for (const month of months) {
        await perpStore.ensure(month);
        await premiumStore.ensure(month);
        if (bybitPremium !== null) await bybitPremium.ensure(month);
      }
      const measure = measureSpreadEpisode(
        ep,
        base,
        other,
        premiumStore.closes,
        otherPremium,
        perpStore.bars,
        VENUE_COSTS[ctx.venue],
        ctx.venue
      );
      result.episodes.push({ ...ep, ...measure, symbol: folder.name });
    }
  }
  return result;
}

function fmt(value: number | null, digits = 4): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const universe = JSON.parse(readFileSync(args.universe, 'utf8')) as UniverseSource;

  let folders: UniverseFolder[];
  if (args.coins) {
    const byName = new Map(universe.folders.map((f) => [f.name, f]));
    folders = args.coins.map((name) => {
      const folder = byName.get(name);
      if (!folder) throw new Error(`Coin ${name} is not in the universe file`);
      return folder;
    });
  } else {
    folders = universe.folders.filter((f) => f.include);
  }
  folders = folders.filter((f) => f.fundingMonths.some((m) => m <= SCOUT_LAST_MONTH));

  const client = new ApiClient(fetch, MIN_GAP_MS[args.venue]);
  const ctx: ScoutContext = { venue: args.venue, cacheRoot: args.cache, client };

  const listed = args.venue === 'hyperliquid' ? await loadHyperliquidCoins(client, args.cache) : await loadBybitSymbols(client, args.cache);
  const matched: Array<{ folder: UniverseFolder; venueSymbol: string }> = [];
  const unmatched: string[] = [];
  for (const folder of folders) {
    const venueSymbol =
      args.venue === 'hyperliquid' ? hyperliquidCoinFor(folder.name, listed) : bybitSymbolFor(folder.name, listed);
    if (venueSymbol === null) unmatched.push(folder.name);
    else matched.push({ folder, venueSymbol });
  }
  console.error(`venue-funding-scout: ${matched.length} matched, ${unmatched.length} unmatched on ${args.venue}`);

  const errors: Array<{ coin: string; message: string }> = [];
  const read: CoinResult[] = [];
  let done = 0;
  for (const { folder, venueSymbol } of matched) {
    try {
      read.push(await scoutCoin(folder, venueSymbol, ctx));
    } catch (error) {
      errors.push({ coin: folder.name, message: error instanceof Error ? error.message : String(error) });
    }
    done++;
    if (done % 10 === 0) console.error(`venue-funding-scout: ${done}/${matched.length} coins`);
  }
  errors.sort((a, b) => (a.coin < b.coin ? -1 : 1));
  const all = read.flatMap((r) => r.episodes);

  const summaries = SPREAD_LEVELS.map((level) =>
    summariseSpread(
      args.venue,
      level,
      all.filter((ep) => ep.level === level)
    )
  );

  const survivorshipNote =
    args.venue === 'bybit'
      ? 'Bybit coverage is NOT survivorship-free: the coin list comes from instruments-info, which holds only CURRENT instruments.'
      : 'Hyperliquid coin list comes from meta (entries flagged isDelisted are kept when the API returns them); history starts 2023-05-12, so the window is 2023-05-12 to 2024-06-30.';

  const report = {
    venue: args.venue,
    params: {
      from: SCOUT_FROM_MS,
      cutoff: SCOUT_CUTOFF_MS,
      levels: SPREAD_LEVELS,
      costs: VENUE_COSTS[args.venue],
      leverages: SCOUT_LEVERAGES,
    },
    universeSha256: universe.sha256,
    coins: {
      matched: matched.length,
      unmatched,
      mapping: Object.fromEntries(matched.map((m) => [m.folder.name, m.venueSymbol])),
    },
    survivorshipNote,
    summaries,
    episodes: all.map((ep) => ({
      symbol: ep.symbol,
      level: ep.level,
      sign: ep.sign,
      entryT: ep.entryT,
      exitT: ep.exitT,
      status: ep.status,
      truncated: ep.truncated,
      grossFunding: ep.grossFunding,
      basisApprox: ep.basisApprox,
      netTaker: ep.net?.[TAKER] ?? null,
      netMaker: ep.net?.[MAKER] ?? null,
      worstLeg: ep.worstLeg,
      holdHours: ep.holdHours,
    })),
    errors,
  };
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  for (const sum of summaries) {
    const taker = sum.net[TAKER];
    const maker = sum.net[MAKER];
    console.log(
      [
        `${args.venue} ${(sum.level * 100).toFixed(2)}%/day`,
        `ok ${sum.counts.ok + sum.counts.noPremium}`,
        `coins ${sum.distinctSymbols}`,
        `hold median ${fmt(sum.holdHours.median, 1)}h`,
        `net taker mean ${fmt(taker.mean)} median ${fmt(taker.median)}`,
        `net maker mean ${fmt(maker.mean)} median ${fmt(maker.median)}`,
        `net>0 taker ${fmt(taker.shareNetPositive, 3)}`,
        `liq3x ${fmt(sum.liquidationShare['3x'], 3)}`,
        `top10 ${fmt(sum.top10Share, 3)}`,
      ].join(' | ')
    );
  }
  console.error(
    `venue-funding-scout: ${read.length} coins read, ${errors.length} errors, report ${args.out}`
  );
  // A hash of the report body for the run log; the report itself carries no wall-clock fields.
  console.error(
    `venue-funding-scout: report sha256 ${createHash('sha256').update(JSON.stringify(report)).digest('hex')}`
  );
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
