/**
 * FUNDING EPISODE CENSUS across all USDT-M perps. A DESCRIPTIVE scout, not a test.
 *
 * PURPOSE. A spot-hedged funding position (long spot, short perp for positive
 * funding; short spot, long perp for negative funding) collects one small
 * payment at every funding settlement and pays fees once per position. The
 * always-on version on ten majors netted +4.57% a year (carry-sim.ts). The
 * event-driven version across the whole perp universe (enter only when funding
 * is extreme) has never been measured. This census sizes how often extreme
 * funding happens, how long it lasts, what it pays after costs and basis, and
 * how often the perp leg would be liquidated. No rule is chosen, no ledger
 * trial is added, nothing here is a result to select on.
 *
 * DATA DISCIPLINE (hard requirement). The script reads nothing after
 * 2024-06-30. The last archive month it may request is `2024-06`
 * (SCOUT_LAST_MONTH). Settlements at or after 2024-07-01 00:00 UTC are dropped
 * (SCOUT_CUTOFF_MS). This is a constant, not a flag, and `monthsBetween`
 * THROWS if asked for a later month. Data from 2024-07-01 onward is reserved
 * for any later pre-registered test.
 *
 * EPISODE RULES, per (side, level). Funding is scaled to an 8h equivalent
 * (r8 = rate x 8 / intervalHours).
 *   positive  starts at settlement k when r8[k] >= level and r8[k-1] < level
 *             (or k is the first), with no episode open. It exits at the first
 *             later settlement with r8 <= 0.01% (the base rate).
 *   negative  starts when r8[k] <= -level and r8[k-1] > -level, and exits at
 *             the first later settlement with r8 >= 0.
 *   An episode with no exit is truncated at the last settlement and excluded
 *   from every statistic. At most one episode is open per call, and the next
 *   can start at the exit index's successor at the earliest.
 *
 * MEASUREMENT (the carry-sim convention). The decision is at entryT (a bar
 * close) and the position enters at the close of the bar opening at
 * entryT - 1h. It collects every settlement with entryT < t <= exitT (the
 * triggering settlement is NOT collected, the exit settlement IS) and leaves at
 * the close of the bar opening at exitT - 1h. Spot and perp are re-marked to
 * constant notional each bar, so basis is the sum of (spot return - perp
 * return) times the side sign. Net = funding + basis - 2 x cost per side.
 *
 * RESULT, 2026-11-10. Universe `21924712` (the broad study's
 * universe-source.json, exchangeInfo 2026-10-07, delisted contracts included),
 * 674 contracts read, 0 errors, 732,088 settlements (626,073 on 8h, 105,733 on
 * 4h, 282 on 2h), 2020-01-01 to 2024-06-30. Report `census.json` on the VPS
 * (`~/funding-scout/out/`, file sha256 `b9acc71a24dc`, body sha256
 * `6c9283ecdeb4`). Run from the branch's code in `crypto-ops:forward-monthly`.
 * Descriptive: no trial is added, the ledger stays at 2,422.
 *
 *   Positive side (long spot, short perp), per episode, cost taker 0.21% a side:
 *   level  ok     coins  no spot  hold med  net mean  net med  net>0  stress mean  liq 2x  liq 3x
 *   0.05%  7,036  277    594      40h       +0.28%    -0.12%   41%    -0.12%       4.1%    8.1%
 *   0.10%  2,566  264    250      60h       +0.79%    +0.20%   61%    +0.39%       6.7%    12.2%
 *   0.20%    735  164     62      80h       +1.58%    +0.87%   77%    +1.18%       8.3%    16.9%
 *   0.50%     36   29      9      56h       +1.90%    +1.47%   81%    +1.50%       5.6%    8.3%
 *   (stress = taker plus 10 bps slippage on each leg, each side. Maker on both
 *   legs adds about +0.18% an episode to the taker mean.)
 *
 *   Per-episode numbers overstate an account's return, because episodes
 *   cluster: at 0.10% up to 229 run at once against an average of 6.2. The
 *   fixed-slot read (`--analyse`, `slotBook`: K slots first come first served,
 *   capital 2 per unit of notional, spot plus 1x perp margin):
 *   level  K   taken  slot use  annual on capital  2020    2021     2022    2023    2024H1 (raw)
 *   0.05%  10  2,231  25%       -1.6%              -3.1%   +7.2%    -0.7%   -5.6%   -5.0%
 *   0.10%  10    837  15%       +3.7%              +3.0%   +13.3%   -0.0%   -0.4%   +1.0%
 *   0.20%  10    253   6%       +3.4%              +3.2%   +10.6%   +0.02%  +0.05%  +1.4%
 *   K 5 and 20 read within a point of K 10 at 0.10% and 0.20%. 1x perp
 *   liquidations (price up 99.5% or more during an episode): 44 of 2,566 at
 *   0.10%, 13 of 735 at 0.20%.
 *
 *   Negative side (short spot, long perp; needs a spot borrow this script does
 *   not price): mean net taker +0.15% to +3.0% per episode but the median is
 *   negative below the 0.50% level (-0.27%, -0.18%, -0.04%, then +0.45%), the
 *   means are carried by a few extreme episodes, and the borrow cost and
 *   availability that would decide it are unknown. Not executable as measured.
 *
 * READING. Extreme positive funding is common (264 coins crossed 0.10% per 8h)
 * and a typical episode pays: at 0.10% the median episode nets +0.20% after
 * taker costs over a 60h hold, collecting a median of 9 settlements, each a
 * small payment. That matches the "many small wins" shape. But it is a
 * bull-market phenomenon: 2021 entries carry 73% of the 0.10% level's total,
 * 2022 had 5 episodes, 2023 netted about zero, 2024H1 recovered modestly. A
 * capital-limited book earns +3% to +4% a year on capital over 2020 to
 * 2024H1, sits idle 85% to 94% of the time, and is roughly flat outside 2021.
 * That is about the always-on ten-major carry's +2.27% on capital at 1x
 * (carry-sim.ts, 2023 to 2026H1) and below a savings yield in most years. The
 * 0.05% level loses: its holds are too short to pay the 0.42% round trip.
 *
 * VERIFIED. (1) Six smoke episodes (BTC, 1000PEPE, TRB, both sides)
 * recomputed from Binance REST funding and 1h klines matched gross, basis and
 * maxAdverse to 10 decimals. (2) An independent Python implementation written
 * blind from the spec, on 25 symbols and 1,673 episodes: every episode, status
 * and spot symbol matched, max difference 8.9e-16 (summation order). (3) The
 * slot book in `--analyse` reproduces a separate Python slot simulation.
 *
 * Usage:
 *   npx tsx scripts/research/funding-scout.ts --universe <universe-source.json> \
 *     --cache <dir> --out <report.json> [--symbols A,B] [--concurrency 4]
 *   npx tsx scripts/research/funding-scout.ts --analyse <report.json>
 *     (offline fixed-slot book read of a finished report, no network)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  fetchArchiveFile,
  parseFundingCsv,
  parseKlineCsv,
  type FundingCsvRow,
  type KlineCsvRow,
} from '@/lib/external/binance-archive';
import { settlementTimeOf } from '@/lib/funding-settlements';

import {
  CARRY_COST_BNB,
  CARRY_COST_MAKER,
  CARRY_COST_TAKER,
  HOUR_MS,
  MAINTENANCE_MARGIN,
  type CostProfile,
} from './carry-sim';
import { assetKey, type UniverseFolder, type UniverseSource } from './universe-source';

export const SCOUT_FROM_MS = Date.UTC(2020, 0, 1);
/** Exclusive: nothing at or after this is read. */
export const SCOUT_CUTOFF_MS = Date.UTC(2024, 6, 1);
export const SCOUT_LAST_MONTH = '2024-06';
/** Per 8h equivalent: 0.05%, 0.1%, 0.2%, 0.5%. */
export const LEVELS = [0.0005, 0.001, 0.002, 0.005];
/** Binance's base rate, 0.01% per 8h. */
export const BASELINE_8H = 0.0001;
export const SCOUT_LEVERAGES = [2, 3];
export const COST_PROFILES: CostProfile[] = [
  CARRY_COST_TAKER,
  CARRY_COST_BNB,
  CARRY_COST_MAKER,
  // 10 bps extra slippage on each leg, each side.
  { name: 'taker+10bps', perSide: CARRY_COST_TAKER.perSide + 0.002 },
];
export type Side = 'positive' | 'negative';
const SIDES: Side[] = ['positive', 'negative'];
/** Fixed-capital slot counts for the offline slot-book read. */
export const SLOT_COUNTS = [5, 10, 20];
/** Capital per unit of notional: spot leg 1 plus perp margin 1 at 1x. */
export const SLOT_CAPITAL_PER_UNIT = 2;

// ---------------------------------------------------------------------------
// Months (the data discipline)
// ---------------------------------------------------------------------------

function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Throws unless the month is at or before SCOUT_LAST_MONTH. Every archive request goes through it. */
export function assertMonthAllowed(month: string): void {
  if (month > SCOUT_LAST_MONTH) {
    throw new Error(`data discipline: month ${month} is after ${SCOUT_LAST_MONTH}`);
  }
}

/**
 * The `YYYY-MM` months touched by [fromMs, toMs] inclusive, ascending. Throws
 * if any of them is after SCOUT_LAST_MONTH.
 */
export function monthsBetween(fromMs: number, toMs: number): string[] {
  if (toMs < fromMs) return [];
  const first = new Date(fromMs);
  const months: string[] = [];
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  const last = monthOf(toMs);
  for (;;) {
    const label = `${year}-${String(month + 1).padStart(2, '0')}`;
    assertMonthAllowed(label);
    months.push(label);
    if (label >= last) break;
    month++;
    if (month === 12) {
      month = 0;
      year++;
    }
  }
  return months;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export interface ScoutSettlement {
  t: number;
  rate: number;
  intervalHours: number;
  /** The rate scaled to an 8h equivalent. */
  r8: number;
}

const KNOWN_GAPS_HOURS = new Set([1, 2, 4, 8]);

export function normaliseSettlements(rows: FundingCsvRow[]): ScoutSettlement[] {
  const kept = rows
    .map((row) => ({ t: settlementTimeOf(row.timestamp), row }))
    .filter(({ t }) => t >= SCOUT_FROM_MS && t < SCOUT_CUTOFF_MS)
    .sort((a, b) => a.t - b.t);

  // A stable sort keeps input order inside a tie, so the last duplicate wins.
  const unique: Array<{ t: number; row: FundingCsvRow }> = [];
  for (const item of kept) {
    if (unique.length > 0 && unique[unique.length - 1].t === item.t) unique[unique.length - 1] = item;
    else unique.push(item);
  }

  return unique.map(({ t, row }, i) => {
    let intervalHours: number;
    if (row.intervalHours !== null && Number.isFinite(row.intervalHours) && row.intervalHours > 0) {
      intervalHours = row.intervalHours;
    } else {
      const gap = i > 0 ? (t - unique[i - 1].t) / HOUR_MS : Number.NaN;
      intervalHours = KNOWN_GAPS_HOURS.has(gap) ? gap : 8;
    }
    return { t, rate: row.rate, intervalHours, r8: (row.rate * 8) / intervalHours };
  });
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface EpisodeWindow {
  side: Side;
  level: number;
  startIdx: number;
  exitIdx: number;
  entryT: number;
  exitT: number;
  truncated: boolean;
}

export function detectEpisodes(s: ScoutSettlement[], level: number, side: Side): EpisodeWindow[] {
  const episodes: EpisodeWindow[] = [];
  const starts = (k: number): boolean =>
    side === 'positive'
      ? s[k].r8 >= level && (k === 0 || s[k - 1].r8 < level)
      : s[k].r8 <= -level && (k === 0 || s[k - 1].r8 > -level);
  const exits = (j: number): boolean =>
    side === 'positive' ? s[j].r8 <= BASELINE_8H + 1e-12 : s[j].r8 >= 0;

  let k = 0;
  while (k < s.length) {
    if (!starts(k)) {
      k++;
      continue;
    }
    let j = k + 1;
    while (j < s.length && !exits(j)) j++;
    if (j >= s.length) {
      const last = s.length - 1;
      episodes.push({
        side,
        level,
        startIdx: k,
        exitIdx: last,
        entryT: s[k].t,
        exitT: s[last].t,
        truncated: true,
      });
      break;
    }
    episodes.push({ side, level, startIdx: k, exitIdx: j, entryT: s[k].t, exitT: s[j].t, truncated: false });
    k = j + 1;
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type MeasureStatus = 'ok' | 'no-spot' | 'gap' | 'empty';

export interface EpisodeMeasure {
  status: MeasureStatus;
  missingBars: number;
  grossFunding: number | null;
  basis: number | null;
  multiplier: number | null;
  premiumEntry: number | null;
  premiumExit: number | null;
  maxAdverse: number | null;
  liquidated: Record<string, boolean> | null;
  holdHours: number | null;
  settlementsCollected: number | null;
  net: Record<string, number> | null;
}

const MULTIPLIERS = [1, 1000, 1_000_000];

function nearestMultiplier(ratio: number): number {
  let best = MULTIPLIERS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const m of MULTIPLIERS) {
    const distance = Math.abs(Math.log(ratio / m));
    if (distance < bestDistance) {
      best = m;
      bestDistance = distance;
    }
  }
  return best;
}

function nullMeasure(status: MeasureStatus, missingBars = 0): EpisodeMeasure {
  return {
    status,
    missingBars,
    grossFunding: null,
    basis: null,
    multiplier: null,
    premiumEntry: null,
    premiumExit: null,
    maxAdverse: null,
    liquidated: null,
    holdHours: null,
    settlementsCollected: null,
    net: null,
  };
}

/** Maps are keyed by bar OPEN time (ms); a bar's close is its open + HOUR_MS. */
export function measureEpisode(
  ep: EpisodeWindow,
  s: ScoutSettlement[],
  perp: ReadonlyMap<number, KlineCsvRow>,
  spot: ReadonlyMap<number, KlineCsvRow> | null
): EpisodeMeasure {
  if (spot === null) return nullMeasure('no-spot');
  if (ep.exitT <= ep.entryT) return nullMeasure('empty');

  const opens: number[] = [];
  for (let open = ep.entryT - HOUR_MS; open <= ep.exitT - HOUR_MS; open += HOUR_MS) opens.push(open);
  let missingBars = 0;
  for (const open of opens) {
    if (!perp.has(open)) missingBars++;
    if (!spot.has(open)) missingBars++;
  }
  if (missingBars > 0) return nullMeasure('gap', missingBars);

  const sign = ep.side === 'positive' ? 1 : -1;

  let sumRate = 0;
  let settlementsCollected = 0;
  for (let i = ep.startIdx + 1; i < s.length && s[i].t <= ep.exitT; i++) {
    if (s[i].t <= ep.entryT) continue;
    sumRate += s[i].rate;
    settlementsCollected++;
  }
  const grossFunding = sign * sumRate;

  let basisSum = 0;
  for (let i = 0; i + 1 < opens.length; i++) {
    const spotNow = spot.get(opens[i])!.close;
    const spotNext = spot.get(opens[i + 1])!.close;
    const perpNow = perp.get(opens[i])!.close;
    const perpNext = perp.get(opens[i + 1])!.close;
    basisSum += spotNext / spotNow - 1 - (perpNext / perpNow - 1);
  }
  const basis = sign * basisSum;

  const entryPerp = perp.get(opens[0])!.close;
  const entrySpot = spot.get(opens[0])!.close;
  const exitPerp = perp.get(opens[opens.length - 1])!.close;
  const exitSpot = spot.get(opens[opens.length - 1])!.close;
  const multiplier = nearestMultiplier(entryPerp / entrySpot);
  const premiumEntry = entryPerp / (entrySpot * multiplier) - 1;
  const premiumExit = exitPerp / (exitSpot * multiplier) - 1;

  // Bars held: opens entryT .. exitT - HOUR_MS (every required bar after the entry bar).
  let maxAdverse: number;
  if (ep.side === 'positive') {
    let high = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < opens.length; i++) high = Math.max(high, perp.get(opens[i])!.high);
    maxAdverse = high / entryPerp - 1;
  } else {
    let low = Number.POSITIVE_INFINITY;
    for (let i = 1; i < opens.length; i++) low = Math.min(low, perp.get(opens[i])!.low);
    maxAdverse = 1 - low / entryPerp;
  }
  const liquidated: Record<string, boolean> = {};
  for (const leverage of SCOUT_LEVERAGES) {
    liquidated[`${leverage}x`] = maxAdverse >= 1 / leverage - MAINTENANCE_MARGIN;
  }

  const net: Record<string, number> = {};
  for (const profile of COST_PROFILES) net[profile.name] = grossFunding + basis - 2 * profile.perSide;

  return {
    status: 'ok',
    missingBars: 0,
    grossFunding,
    basis,
    multiplier,
    premiumEntry,
    premiumExit,
    maxAdverse,
    liquidated,
    holdHours: (ep.exitT - ep.entryT) / HOUR_MS,
    settlementsCollected,
    net,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Quantile by linear interpolation on an ASCENDING sorted array; null when empty. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Dist {
  mean: number | null;
  median: number | null;
  p10: number | null;
  p90: number | null;
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

export type MeasuredEpisode = EpisodeWindow & EpisodeMeasure & { symbol: string };

export interface NetSummary extends Dist {
  shareNetPositive: number | null;
}

export interface LevelSummary {
  level: number;
  side: Side;
  counts: { total: number; ok: number; noSpot: number; gap: number; empty: number; truncated: number };
  distinctSymbols: number;
  grossFunding: Dist;
  basis: Dist;
  holdHours: Dist;
  settlementsMedian: number | null;
  net: Record<string, NetSummary>;
  liquidationShare: Record<string, number | null>;
  byYear: Record<string, { n: number; meanNetTaker: number; sumNetTaker: number }>;
  top10Share: number | null;
}

export function summarise(level: number, side: Side, episodes: MeasuredEpisode[]): LevelSummary {
  const counts = { total: episodes.length, ok: 0, noSpot: 0, gap: 0, empty: 0, truncated: 0 };
  const ok: MeasuredEpisode[] = [];
  for (const ep of episodes) {
    if (ep.truncated) counts.truncated++;
    else if (ep.status === 'ok') {
      counts.ok++;
      ok.push(ep);
    } else if (ep.status === 'no-spot') counts.noSpot++;
    else if (ep.status === 'gap') counts.gap++;
    else counts.empty++;
  }

  const take = (pick: (ep: MeasuredEpisode) => number | null): number[] =>
    ok.map(pick).filter((v): v is number => v !== null);

  const net: Record<string, NetSummary> = {};
  for (const profile of COST_PROFILES) {
    const values = take((ep) => ep.net?.[profile.name] ?? null);
    net[profile.name] = {
      ...distOf(values),
      shareNetPositive: values.length === 0 ? null : values.filter((v) => v > 0).length / values.length,
    };
  }

  const liquidationShare: Record<string, number | null> = {};
  for (const leverage of SCOUT_LEVERAGES) {
    const key = `${leverage}x`;
    liquidationShare[key] = ok.length === 0 ? null : ok.filter((ep) => ep.liquidated?.[key] === true).length / ok.length;
  }

  const takerNets = ok.map((ep) => ep.net?.[CARRY_COST_TAKER.name] ?? 0);
  const byYear: LevelSummary['byYear'] = {};
  ok.forEach((ep, i) => {
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
    level,
    side,
    counts,
    distinctSymbols: new Set(ok.map((ep) => ep.symbol)).size,
    grossFunding: distOf(take((ep) => ep.grossFunding)),
    basis: distOf(take((ep) => ep.basis)),
    holdHours: distOf(take((ep) => ep.holdHours)),
    settlementsMedian: quantile(
      take((ep) => ep.settlementsCollected).sort((a, b) => a - b),
      0.5
    ),
    net,
    liquidationShare,
    byYear,
    top10Share: total <= 0 ? null : top10 / total,
  };
}

// ---------------------------------------------------------------------------
// Slot book (offline read of the report JSON)
// ---------------------------------------------------------------------------

/** The shape `main` writes into the report's `episodes`. */
export interface ReportEpisodeRow {
  symbol: string;
  side: Side;
  level: number;
  entryT: number;
  exitT: number;
  status: string;
  truncated: boolean;
  netTaker: number | null;
  maxAdverse: number | null;
}

export interface SlotBookResult {
  side: Side;
  level: number;
  slots: number;
  eligible: number;
  taken: number;
  totalNetTaker: number;
  annualReturnOnCapital: number;
  slotUse: number;
  perpLiquidations1x: number;
  byYear: Record<string, { n: number; sumNetTaker: number; returnOnCapital: number }>;
}

/**
 * K fixed slots, first come first served. Eligible rows are taken in
 * (entryT, symbol) order into the slot that frees earliest (lowest index on
 * ties) when that slot is free by the row's entryT; otherwise the row is skipped.
 */
export function slotBook(
  rows: readonly ReportEpisodeRow[],
  side: Side,
  level: number,
  slots: number
): SlotBookResult {
  const eligible = rows
    .filter((r) => r.side === side && r.level === level && r.status === 'ok' && !r.truncated && r.netTaker !== null)
    .sort((a, b) => a.entryT - b.entryT || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  const spanMs = SCOUT_CUTOFF_MS - SCOUT_FROM_MS;
  const capital = slots * SLOT_CAPITAL_PER_UNIT;
  const freeAt = new Array<number>(slots).fill(0);
  let taken = 0;
  let totalNetTaker = 0;
  let slotUse = 0;
  const byYear: SlotBookResult['byYear'] = {};

  for (const row of eligible) {
    let best = 0;
    for (let i = 1; i < slots; i++) if (freeAt[i] < freeAt[best]) best = i;
    if (freeAt[best] > row.entryT) continue;
    freeAt[best] = row.exitT;
    const net = row.netTaker as number;
    taken++;
    totalNetTaker += net;
    slotUse += (row.exitT - row.entryT) / (slots * spanMs);
    const year = String(new Date(row.entryT).getUTCFullYear());
    const entry = byYear[year] ?? { n: 0, sumNetTaker: 0, returnOnCapital: 0 };
    entry.n++;
    entry.sumNetTaker += net;
    entry.returnOnCapital = entry.sumNetTaker / capital;
    byYear[year] = entry;
  }

  const years = spanMs / (365 * 24 * HOUR_MS);
  return {
    side,
    level,
    slots,
    eligible: eligible.length,
    taken,
    totalNetTaker,
    annualReturnOnCapital: totalNetTaker / capital / years,
    slotUse,
    perpLiquidations1x: eligible.filter((r) => r.maxAdverse !== null && r.maxAdverse >= 1 - MAINTENANCE_MARGIN).length,
    byYear,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ScoutArgs {
  universe: string;
  cache: string;
  out: string;
  symbols: string[] | null;
  concurrency: number;
  /** Offline slot-book mode: the report JSON to read. Excludes every other flag. */
  analyse: string | null;
}

export function parseArgs(argv: string[]): ScoutArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const key = flag.slice(2);
    if (!['universe', 'cache', 'out', 'symbols', 'concurrency', 'analyse'].includes(key)) {
      throw new Error(`Unknown flag ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    flags.set(key, value);
    i++;
  }
  if (flags.has('analyse')) {
    if (flags.size > 1) throw new Error('--analyse cannot be combined with other flags');
    return { universe: '', cache: '', out: '', symbols: null, concurrency: 4, analyse: flags.get('analyse')! };
  }
  for (const required of ['universe', 'cache', 'out']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }
  const concurrency = flags.has('concurrency') ? Number(flags.get('concurrency')) : 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return {
    universe: flags.get('universe')!,
    cache: flags.get('cache')!,
    out: flags.get('out')!,
    symbols: flags.has('symbols')
      ? flags
          .get('symbols')!
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : null,
    concurrency,
    analyse: null,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Lazily loads whole months of 1h klines for one (dataset, symbol) into one open-time map. */
class KlineStore {
  readonly bars = new Map<number, KlineCsvRow>();
  private readonly months = new Map<string, boolean>();

  constructor(
    private readonly dataset: 'klines' | 'spotKlines',
    private readonly symbol: string,
    private readonly cacheDir: string
  ) {}

  /** True when the month's file exists. Requests only months at or before SCOUT_LAST_MONTH. */
  async ensure(month: string): Promise<boolean> {
    assertMonthAllowed(month);
    const known = this.months.get(month);
    if (known !== undefined) return known;
    const csv = await fetchArchiveFile(
      { dataset: this.dataset, symbol: this.symbol, interval: '1h', date: month },
      { cacheDir: this.cacheDir }
    );
    if (csv === null) {
      this.months.set(month, false);
      return false;
    }
    for (const row of parseKlineCsv(csv)) this.bars.set(row.timestamp, row);
    this.months.set(month, true);
    return true;
  }
}

interface SymbolResult {
  symbol: string;
  settlements: ScoutSettlement[];
  episodes: Array<MeasuredEpisode & { spotSymbol: string | null }>;
}

async function scoutSymbol(folder: UniverseFolder, cacheDir: string): Promise<SymbolResult> {
  const rows: FundingCsvRow[] = [];
  for (const month of folder.fundingMonths.filter((m) => m <= SCOUT_LAST_MONTH)) {
    assertMonthAllowed(month);
    const csv = await fetchArchiveFile({ dataset: 'fundingRate', symbol: folder.name, date: month }, { cacheDir });
    if (csv !== null) rows.push(...parseFundingCsv(csv));
  }
  const settlements = normaliseSettlements(rows);

  const perp = new KlineStore('klines', folder.name, cacheDir);
  const spotCandidates = [...new Set([folder.name, `${assetKey(folder.name)}USDT`])];
  const spotStores = new Map<string, KlineStore>(
    spotCandidates.map((name) => [name, new KlineStore('spotKlines', name, cacheDir)])
  );

  const episodes: SymbolResult['episodes'] = [];
  for (const level of LEVELS) {
    for (const side of SIDES) {
      for (const window of detectEpisodes(settlements, level, side)) {
        const months = monthsBetween(window.entryT - HOUR_MS, window.exitT);
        for (const month of months) await perp.ensure(month);

        let spotSymbol: string | null = null;
        for (const name of spotCandidates) {
          if (await spotStores.get(name)!.ensure(months[0])) {
            spotSymbol = name;
            break;
          }
        }
        if (spotSymbol !== null) {
          for (const month of months) await spotStores.get(spotSymbol)!.ensure(month);
        }

        const measure = measureEpisode(
          window,
          settlements,
          perp.bars,
          spotSymbol === null ? null : spotStores.get(spotSymbol)!.bars
        );
        episodes.push({ ...window, ...measure, symbol: folder.name, spotSymbol });
      }
    }
  }
  return { symbol: folder.name, settlements, episodes };
}

function fmt(value: number | null, digits = 4): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function analyseReport(reportPath: string): number {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { episodes: ReportEpisodeRow[] };
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  for (const level of LEVELS) {
    for (const slots of SLOT_COUNTS) {
      const r = slotBook(report.episodes, 'positive', level, slots);
      const years = Object.entries(r.byYear)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([year, y]) => `${year}: ${pct(y.returnOnCapital)} (${y.n})`)
        .join(', ');
      console.log(
        [
          `positive ${(level * 100).toFixed(2)}%`,
          `K ${slots}`,
          `eligible ${r.eligible}`,
          `taken ${r.taken}`,
          `slot use ${pct(r.slotUse)}`,
          `annual return on capital ${pct(r.annualReturnOnCapital)}`,
          `1x perp liquidations ${r.perpLiquidations1x}`,
          `by year ${years === '' ? 'n/a' : years}`,
        ].join(' | ')
      );
    }
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.analyse !== null) return analyseReport(args.analyse);
  const universe = JSON.parse(readFileSync(args.universe, 'utf8')) as UniverseSource;

  let folders: UniverseFolder[];
  if (args.symbols) {
    const byName = new Map(universe.folders.map((f) => [f.name, f]));
    folders = args.symbols.map((name) => {
      const folder = byName.get(name);
      if (!folder) throw new Error(`Symbol ${name} is not in the universe file`);
      return folder;
    });
    folders = folders.filter((f) => f.fundingMonths.length > 0);
  } else {
    folders = universe.folders.filter((f) => f.include && f.fundingMonths.length > 0);
  }

  const errors: Array<{ symbol: string; message: string }> = [];
  let done = 0;
  const results = await mapLimit(folders, args.concurrency, async (folder): Promise<SymbolResult | null> => {
    try {
      return await scoutSymbol(folder, args.cache);
    } catch (error) {
      errors.push({ symbol: folder.name, message: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      done++;
      if (done % 25 === 0) console.error(`funding-scout: ${done}/${folders.length} symbols`);
    }
  });

  const read = results.filter((r): r is SymbolResult => r !== null);
  errors.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  const all = read.flatMap((r) => r.episodes);

  const intervalHoursCounts: Record<string, number> = {};
  let settlementCount = 0;
  for (const r of read) {
    for (const st of r.settlements) {
      settlementCount++;
      intervalHoursCounts[String(st.intervalHours)] = (intervalHoursCounts[String(st.intervalHours)] ?? 0) + 1;
    }
  }

  const summaries: LevelSummary[] = [];
  for (const side of SIDES) {
    for (const level of LEVELS) {
      summaries.push(
        summarise(
          level,
          side,
          all.filter((ep) => ep.side === side && ep.level === level)
        )
      );
    }
  }

  const report = {
    params: {
      from: SCOUT_FROM_MS,
      cutoff: SCOUT_CUTOFF_MS,
      lastMonth: SCOUT_LAST_MONTH,
      levels: LEVELS,
      baseline8h: BASELINE_8H,
      costProfiles: COST_PROFILES,
      leverages: SCOUT_LEVERAGES,
    },
    universeSha256: universe.sha256,
    symbolsRead: read.length,
    symbolsWithSettlements: read.filter((r) => r.settlements.length > 0).length,
    settlementCount,
    intervalHoursCounts: Object.fromEntries(
      Object.entries(intervalHoursCounts).sort(([a], [b]) => Number(a) - Number(b))
    ),
    errors,
    summaries,
    episodes: all.map((ep) => ({
      symbol: ep.symbol,
      side: ep.side,
      level: ep.level,
      entryT: ep.entryT,
      exitT: ep.exitT,
      status: ep.status,
      truncated: ep.truncated,
      spotSymbol: ep.spotSymbol,
      grossFunding: ep.grossFunding,
      basis: ep.basis,
      netTaker: ep.net?.[CARRY_COST_TAKER.name] ?? null,
      maxAdverse: ep.maxAdverse,
      holdHours: ep.holdHours,
    })),
  };
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  for (const sum of summaries) {
    const taker = sum.net[CARRY_COST_TAKER.name];
    console.log(
      [
        `${sum.side} ${(sum.level * 100).toFixed(2)}%`,
        `ok ${sum.counts.ok}`,
        `symbols ${sum.distinctSymbols}`,
        `hold median ${fmt(sum.holdHours.median, 1)}h`,
        `net taker mean ${fmt(taker.mean)} median ${fmt(taker.median)}`,
        `net>0 ${fmt(taker.shareNetPositive, 3)}`,
        `liq3x ${fmt(sum.liquidationShare['3x'], 3)}`,
        `top10 ${fmt(sum.top10Share, 3)}`,
      ].join(' | ')
    );
  }
  console.error(`funding-scout: ${read.length} symbols read, ${errors.length} errors, report ${args.out}`);
  // A hash of the report body for the run log; the report itself carries no wall-clock fields.
  console.error(`funding-scout: report sha256 ${createHash('sha256').update(JSON.stringify(report)).digest('hex')}`);
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
