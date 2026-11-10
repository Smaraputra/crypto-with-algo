/**
 * LISTING-AGE DRIFT CENSUS across USDT-M perps. A DESCRIPTIVE scout, not a test.
 *
 * PURPOSE. Every broad study required 366 days of history, so a contract's
 * first year was never read. This census measures what a perp does after its
 * listing: a short held from day N after the first bar, for H days, by
 * listing-year cohort, with the worst squeeze per position. It is DESCRIPTIVE
 * like scripts/research/funding-scout.ts: no rule is chosen, no ledger trial
 * is added, nothing here is a result to select on.
 *
 * DATA DISCIPLINE (hard requirement). Nothing at or after 2024-07-01 00:00 UTC
 * is requested or kept. Every archive month goes through monthsBetween or
 * assertMonthAllowed from ./funding-scout (they throw after 2024-06). Rows at
 * or after SCOUT_CUTOFF_MS are dropped. Listings later than 2024-06-30 stay
 * unread for a possible lock.
 *
 * DEFINITIONS.
 * - Universe: folders with include === true and at least one kline month at or
 *   before 2024-06. Delisted contracts are included.
 * - Listing time L: the open time of the first 1h kline of the symbol in the
 *   first month of klineMonths. A contract is LEFT-CENSORED and excluded
 *   (counted) when L < Date.UTC(2020, 0, 3) (the archive starts then, so its
 *   true listing is unknown).
 * - Cohort: the UTC year of L (2020, 2021, 2022, 2023, 2024-H1).
 * - Position (short perp, taker both ends): entry at the OPEN of the first 1h
 *   bar with open time >= L + N days; exit at the CLOSE of the last 1h bar
 *   with open time < entry + H days (that is entryT + H*24h). Parameter grid:
 *   N in {1, 7, 30} days, H in {30, 90, 180} days. A position whose exit bar
 *   would be at or after the cutoff is excluded and counted as truncatedAtCutoff.
 *   A position whose symbol delists (last bar) before the exit is closed at the
 *   last bar's close and flagged delisted. Each contract yields at most one
 *   position per (N, H).
 * - Price return of the short: -(exitClose / entryOpen - 1).
 * - Funding: sum of rate over normalised settlements with entryT < t <= exitT
 *   (use normaliseSettlements on the symbol's fundingMonths <= 2024-06). A short
 *   RECEIVES a positive rate, so funding = +sum(rate). A position with no
 *   settlement in its window records funding = null and is counted in noFunding
 *   (then net uses 0 for funding and the flag stays visible).
 * - Gross = price return + funding. Costs: taker = 2 x (0.0005 + 0.0003) = 0.0016,
 *   maker = 2 x 0.0002 = 0.0004, and taker+10bps = 2 x (0.0005 + 0.0013) = 0.0036.
 *   Net = gross - cost, per profile.
 * - Worst squeeze per position: max over bars in the hold of (high / entryOpen - 1)
 *   (the adverse excursion of a short). Also record liquidated1x: true when
 *   maxHigh / entryOpen - 1 >= 1 - MAINTENANCE_MARGIN (0.005), i.e. a 1x short
 *   would be liquidated.
 *
 * LIMITATION. Listings cluster in time and positions within a month are not
 * independent. For each (N, H) cell, the equal-weight mean net taker by listing
 * month is reported as a cluster check: the number of months with positive mean
 * and the total number of months.
 *
 * RESULT: not run yet
 *
 * Usage:
 *   npx tsx scripts/research/listing-census.ts --universe <universe-source.json> \
 *     --cache <dir> --out <report.json> [--symbols A,B] [--concurrency 4]
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

import { HOUR_MS, MAINTENANCE_MARGIN } from './carry-sim';
import {
  assertMonthAllowed,
  monthsBetween,
  normaliseSettlements,
  quantile,
  SCOUT_CUTOFF_MS,
  SCOUT_FROM_MS,
  SCOUT_LAST_MONTH,
  type ScoutSettlement,
} from './funding-scout';
import type { UniverseFolder, UniverseSource } from './universe-source';

export {
  assertMonthAllowed,
  monthsBetween,
  normaliseSettlements,
  quantile,
  SCOUT_CUTOFF_MS,
  SCOUT_FROM_MS,
  SCOUT_LAST_MONTH,
};

export const LEFT_CENSOR_CUTOFF_MS = Date.UTC(2020, 0, 3);
export const N_GRID = [1, 7, 30] as const;
export const H_GRID = [30, 90, 180] as const;

export const CENSUS_COSTS = {
  taker: 2 * (0.0005 + 0.0003),
  maker: 2 * 0.0002,
  'taker+10bps': 2 * (0.0005 + 0.0013),
} as const;

export type CostProfileName = keyof typeof CENSUS_COSTS;

/**
 * Returns the open time of the first 1h kline in the symbol's first kline month,
 * or null if no bars are present.
 */
export function listingTime(bars: readonly { timestamp: number }[]): number | null {
  if (bars.length === 0) return null;
  let min = bars[0].timestamp;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].timestamp < min) min = bars[i].timestamp;
  }
  return min;
}

/**
 * Contract is left-censored when L < 2020-01-03 UTC.
 */
export function isLeftCensored(listingMs: number): boolean {
  return listingMs < LEFT_CENSOR_CUTOFF_MS;
}

/**
 * Returns the cohort label for a listing timestamp:
 * 2020, 2021, 2022, 2023, 2024-H1.
 */
export function cohortOf(listingMs: number): string {
  const year = new Date(listingMs).getUTCFullYear();
  if (year === 2024) return '2024-H1';
  return String(year);
}

export type BuildPositionResult =
  | {
      status: 'ok';
      entryT: number;
      exitT: number;
      entryOpen: number;
      exitClose: number;
      priceReturn: number;
      funding: number | null;
      squeeze: number;
      liquidated1x: boolean;
      delisted: boolean;
      noFunding: boolean;
    }
  | {
      status: 'truncatedAtCutoff';
    }
  | {
      status: 'noEntry';
    };

/**
 * Builds one short position for (nDays, hDays) from the contract's 1h bars and settlements.
 */
export function buildPosition(
  bars: readonly KlineCsvRow[],
  settlements: readonly ScoutSettlement[],
  listing: number,
  nDays: number,
  hDays: number
): BuildPositionResult {
  const minEntryT = listing + nDays * 24 * HOUR_MS;
  if (minEntryT >= SCOUT_CUTOFF_MS) {
    return { status: 'truncatedAtCutoff' };
  }

  let entryIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].timestamp >= minEntryT) {
      entryIdx = i;
      break;
    }
  }

  if (entryIdx === -1) {
    return { status: 'noEntry' };
  }

  const entryBar = bars[entryIdx];
  const entryT = entryBar.timestamp;
  const entryOpen = entryBar.open;
  const targetExitT = entryT + hDays * 24 * HOUR_MS;

  if (targetExitT >= SCOUT_CUTOFF_MS) {
    return { status: 'truncatedAtCutoff' };
  }

  let exitIdx = entryIdx;
  let maxHigh = entryBar.high;

  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i];
    if (b.timestamp >= targetExitT) break;
    exitIdx = i;
    if (b.high > maxHigh) {
      maxHigh = b.high;
    }
  }

  const exitBar = bars[exitIdx];
  const exitT = exitBar.timestamp + HOUR_MS;
  const exitClose = exitBar.close;
  const delisted = exitT < targetExitT;

  const priceReturn = -(exitClose / entryOpen - 1);

  let fundingSum = 0;
  let settlementCount = 0;
  for (const s of settlements) {
    if (s.t > entryT && s.t <= exitT) {
      fundingSum += s.rate;
      settlementCount++;
    }
  }

  const noFunding = settlementCount === 0;
  const funding = noFunding ? null : fundingSum;

  const squeeze = maxHigh / entryOpen - 1;
  const liquidated1x = squeeze >= 1 - MAINTENANCE_MARGIN;

  return {
    status: 'ok',
    entryT,
    exitT,
    entryOpen,
    exitClose,
    priceReturn,
    funding,
    squeeze,
    liquidated1x,
    delisted,
    noFunding,
  };
}

/**
 * Net return after subtracting cost for the given profile.
 */
export function costNet(
  grossOrPos: number | { priceReturn: number; funding?: number | null },
  profile: CostProfileName
): number {
  const gross =
    typeof grossOrPos === 'number'
      ? grossOrPos
      : grossOrPos.priceReturn + (grossOrPos.funding ?? 0);
  return gross - CENSUS_COSTS[profile];
}

export interface CohortPositionInput {
  priceReturn: number;
  funding: number | null;
  squeeze: number;
  liquidated1x: boolean;
  delisted: boolean;
  noFunding?: boolean;
  truncatedAtCutoff?: boolean;
}

export interface MetricDist {
  mean: number | null;
  median: number | null;
  p10: number | null;
  p90: number | null;
}

export interface NetSummary extends MetricDist {
  sharePositive: number | null;
}

export interface CohortSummaryFull {
  n: number;
  sharePositive: number | null;
  netTaker: NetSummary;
  netMaker: MetricDist;
  meanFunding: number | null;
  medianSqueeze: number | null;
  p90Squeeze: number | null;
  p99Squeeze: number | null;
  liquidated1x: number;
  delisted: number;
  noFunding: number;
  truncatedAtCutoff: number;
  meanNetTaker?: number | null;
  medianNetTaker?: number | null;
  p10NetTaker?: number | null;
  p90NetTaker?: number | null;
  meanNetMaker?: number | null;
  medianNetMaker?: number | null;
  p10NetMaker?: number | null;
  p90NetMaker?: number | null;
}

export interface CohortSummarySmall {
  n: number;
}

export type CohortSummary = CohortSummaryFull | CohortSummarySmall;

/**
 * Summarises cohort statistics. Reports only n when n < 5.
 */
export function summariseCohort(
  positions: readonly CohortPositionInput[],
  truncatedAtCutoffCount = 0
): CohortSummary {
  const completed = positions.filter((p) => !p.truncatedAtCutoff);
  const truncatedFromArr = positions.filter((p) => p.truncatedAtCutoff).length;
  const totalTruncated = truncatedAtCutoffCount + truncatedFromArr;

  const n = completed.length;
  if (n < 5) {
    return { n };
  }

  const netTakerValues = completed.map((p) => {
    const gross = p.priceReturn + (p.funding ?? 0);
    return costNet(gross, 'taker');
  });

  const netMakerValues = completed.map((p) => {
    const gross = p.priceReturn + (p.funding ?? 0);
    return costNet(gross, 'maker');
  });

  const sortedNetTaker = [...netTakerValues].sort((a, b) => a - b);
  const sortedNetMaker = [...netMakerValues].sort((a, b) => a - b);

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const netTakerDist: NetSummary = {
    mean: mean(netTakerValues),
    median: quantile(sortedNetTaker, 0.5),
    p10: quantile(sortedNetTaker, 0.1),
    p90: quantile(sortedNetTaker, 0.9),
    sharePositive: netTakerValues.filter((v) => v > 0).length / n,
  };

  const netMakerDist: MetricDist = {
    mean: mean(netMakerValues),
    median: quantile(sortedNetMaker, 0.5),
    p10: quantile(sortedNetMaker, 0.1),
    p90: quantile(sortedNetMaker, 0.9),
  };

  const fundingValues = completed.map((p) => p.funding ?? 0);
  const meanFunding = mean(fundingValues);

  const squeezeValues = completed.map((p) => p.squeeze);
  const sortedSqueeze = [...squeezeValues].sort((a, b) => a - b);
  const medianSqueeze = quantile(sortedSqueeze, 0.5);
  const p90Squeeze = quantile(sortedSqueeze, 0.9);
  const p99Squeeze = quantile(sortedSqueeze, 0.99);

  const liquidated1x = completed.filter((p) => p.liquidated1x).length;
  const delisted = completed.filter((p) => p.delisted).length;
  const noFunding = completed.filter((p) => p.funding === null || p.noFunding === true).length;

  return {
    n,
    sharePositive: netTakerDist.sharePositive,
    netTaker: netTakerDist,
    netMaker: netMakerDist,
    meanFunding,
    medianSqueeze,
    p90Squeeze,
    p99Squeeze,
    liquidated1x,
    delisted,
    noFunding,
    truncatedAtCutoff: totalTruncated,
    meanNetTaker: netTakerDist.mean,
    medianNetTaker: netTakerDist.median,
    p10NetTaker: netTakerDist.p10,
    p90NetTaker: netTakerDist.p90,
    meanNetMaker: netMakerDist.mean,
    medianNetMaker: netMakerDist.median,
    p10NetMaker: netMakerDist.p10,
    p90NetMaker: netMakerDist.p90,
  };
}

/**
 * Returns archive months touched by a position.
 * Throws through assertMonthAllowed if any month is after SCOUT_LAST_MONTH (2024-06).
 */
export function monthsForPosition(entryT: number, hDaysOrExitT: number): string[] {
  const exitT = hDaysOrExitT > 10_000_000 ? hDaysOrExitT : entryT + hDaysOrExitT * 24 * HOUR_MS;
  return monthsBetween(entryT, exitT);
}

export interface MonthClusterCheck {
  months: number;
  positiveMonths: number;
  equalWeightMeanNetTaker: number | null;
}

/**
 * Computes equal-weight mean net taker by listing month to check temporal clustering.
 */
export function computeMonthClusterCheck(
  rows: readonly { listing: number; priceReturn: number; funding: number | null }[]
): MonthClusterCheck {
  if (rows.length === 0) {
    return { months: 0, positiveMonths: 0, equalWeightMeanNetTaker: null };
  }

  const byMonth = new Map<string, number[]>();
  for (const row of rows) {
    const d = new Date(row.listing);
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const gross = row.priceReturn + (row.funding ?? 0);
    const netTaker = costNet(gross, 'taker');
    const list = byMonth.get(m);
    if (list) list.push(netTaker);
    else byMonth.set(m, [netTaker]);
  }

  let positiveMonths = 0;
  let sumMeans = 0;
  for (const nets of byMonth.values()) {
    const monthMean = nets.reduce((a, b) => a + b, 0) / nets.length;
    if (monthMean > 0) positiveMonths++;
    sumMeans += monthMean;
  }

  const months = byMonth.size;
  const equalWeightMeanNetTaker = months > 0 ? sumMeans / months : null;

  return {
    months,
    positiveMonths,
    equalWeightMeanNetTaker,
  };
}

export class KlineStore {
  readonly bars = new Map<number, KlineCsvRow>();
  private readonly months = new Map<string, boolean>();

  constructor(
    private readonly symbol: string,
    private readonly cacheDir: string
  ) {}

  async ensure(month: string): Promise<boolean> {
    assertMonthAllowed(month);
    const known = this.months.get(month);
    if (known !== undefined) return known;
    const csv = await fetchArchiveFile(
      { dataset: 'klines', symbol: this.symbol, interval: '1h', date: month },
      { cacheDir: this.cacheDir }
    );
    if (csv === null) {
      this.months.set(month, false);
      return false;
    }
    for (const row of parseKlineCsv(csv)) {
      if (row.timestamp < SCOUT_CUTOFF_MS) {
        this.bars.set(row.timestamp, row);
      }
    }
    this.months.set(month, true);
    return true;
  }

  getBarsSorted(): KlineCsvRow[] {
    return Array.from(this.bars.values()).sort((a, b) => a.timestamp - b.timestamp);
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
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

export interface CensusArgs {
  universe: string;
  cache: string;
  out: string;
  symbols: string[] | null;
  concurrency: number;
}

export function parseArgs(argv: string[]): CensusArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const key = flag.slice(2);
    if (!['universe', 'cache', 'out', 'symbols', 'concurrency'].includes(key)) {
      throw new Error(`Unknown flag ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    flags.set(key, value);
    i++;
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
  };
}

export interface PositionRow {
  symbol: string;
  listing: number;
  cohort: string;
  n: number;
  h: number;
  entryT: number;
  exitT: number;
  priceReturn: number;
  funding: number | null;
  squeeze: number;
  liquidated1x: boolean;
  delisted: boolean;
}

export interface GridCellSummary {
  n: number;
  h: number;
  cohorts: Record<string, CohortSummary>;
  all: CohortSummary;
  clusterByMonth: MonthClusterCheck;
}

export interface CensusOutput {
  params: {
    nGrid: readonly number[];
    hGrid: readonly number[];
    cutoffMs: number;
    lastMonth: string;
    leftCensorCutoffMs: number;
    costProfiles: typeof CENSUS_COSTS;
  };
  universeSha256: string;
  counts: {
    contracts: number;
    leftCensored: number;
    noKlines: number;
  };
  errors: Array<{ symbol: string; error: string }>;
  summaries: GridCellSummary[];
  rows: PositionRow[];
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const universeRaw = readFileSync(args.universe, 'utf8');
  const universeSha256 = createHash('sha256').update(universeRaw).digest('hex');
  const universe: UniverseSource = JSON.parse(universeRaw);

  let folders = universe.folders.filter(
    (f: UniverseFolder) => f.include === true && f.klineMonths.some((m) => m <= SCOUT_LAST_MONTH)
  );

  if (args.symbols !== null) {
    const symbolSet = new Set(args.symbols);
    folders = folders.filter((f) => symbolSet.has(f.name));
  }

  const contractsCount = folders.length;
  let leftCensoredCount = 0;
  let noKlinesCount = 0;
  const errors: Array<{ symbol: string; error: string }> = [];
  const allRows: PositionRow[] = [];
  const truncatedCounts: Record<string, number> = {};

  await mapLimit(folders, args.concurrency, async (folder) => {
    try {
      const klineMonths = folder.klineMonths.filter((m) => m <= SCOUT_LAST_MONTH).sort();
      if (klineMonths.length === 0) {
        noKlinesCount++;
        return;
      }

      const firstMonth = klineMonths[0];
      assertMonthAllowed(firstMonth);
      const firstCsv = await fetchArchiveFile(
        { dataset: 'klines', symbol: folder.name, interval: '1h', date: firstMonth },
        { cacheDir: args.cache }
      );
      if (firstCsv === null) {
        noKlinesCount++;
        return;
      }

      const firstBars = parseKlineCsv(firstCsv)
        .filter((b) => b.timestamp < SCOUT_CUTOFF_MS)
        .sort((a, b) => a.timestamp - b.timestamp);
      const L = listingTime(firstBars);
      if (L === null) {
        noKlinesCount++;
        return;
      }

      if (isLeftCensored(L)) {
        leftCensoredCount++;
        return;
      }

      const cohort = cohortOf(L);

      const klineStore = new KlineStore(folder.name, args.cache);
      for (const m of klineMonths) {
        await klineStore.ensure(m);
      }
      const allBars = klineStore.getBarsSorted();

      const fundingMonths = folder.fundingMonths.filter((m) => m <= SCOUT_LAST_MONTH).sort();
      const fundingRows: FundingCsvRow[] = [];
      for (const m of fundingMonths) {
        assertMonthAllowed(m);
        const fCsv = await fetchArchiveFile(
          { dataset: 'fundingRate', symbol: folder.name, date: m },
          { cacheDir: args.cache }
        );
        if (fCsv !== null) fundingRows.push(...parseFundingCsv(fCsv));
      }
      const settlements = normaliseSettlements(fundingRows);

      for (const n of N_GRID) {
        for (const h of H_GRID) {
          const res = buildPosition(allBars, settlements, L, n, h);
          const cohortKey = `${n}_${h}_${cohort}`;
          const allKey = `${n}_${h}_all`;
          if (res.status === 'truncatedAtCutoff') {
            truncatedCounts[cohortKey] = (truncatedCounts[cohortKey] ?? 0) + 1;
            truncatedCounts[allKey] = (truncatedCounts[allKey] ?? 0) + 1;
          } else if (res.status === 'ok') {
            allRows.push({
              symbol: folder.name,
              listing: L,
              cohort,
              n,
              h,
              entryT: res.entryT,
              exitT: res.exitT,
              priceReturn: res.priceReturn,
              funding: res.funding,
              squeeze: res.squeeze,
              liquidated1x: res.liquidated1x,
              delisted: res.delisted,
            });
          }
        }
      }
    } catch (err) {
      errors.push({ symbol: folder.name, error: (err as Error).message });
    }
  });

  const cohorts = ['2020', '2021', '2022', '2023', '2024-H1'];
  const summaries: GridCellSummary[] = [];

  for (const n of N_GRID) {
    for (const h of H_GRID) {
      const nhRows = allRows.filter((r) => r.n === n && r.h === h);
      const cohortSummaries: Record<string, CohortSummary> = {};

      for (const cohort of cohorts) {
        const cohortRows = nhRows.filter((r) => r.cohort === cohort);
        const truncCount = truncatedCounts[`${n}_${h}_${cohort}`] ?? 0;
        cohortSummaries[cohort] = summariseCohort(cohortRows, truncCount);
      }

      const allTruncCount = truncatedCounts[`${n}_${h}_all`] ?? 0;
      const allSummary = summariseCohort(nhRows, allTruncCount);
      const clusterByMonth = computeMonthClusterCheck(nhRows);

      summaries.push({
        n,
        h,
        cohorts: cohortSummaries,
        all: allSummary,
        clusterByMonth,
      });
    }
  }

  const output: CensusOutput = {
    params: {
      nGrid: N_GRID,
      hGrid: H_GRID,
      cutoffMs: SCOUT_CUTOFF_MS,
      lastMonth: SCOUT_LAST_MONTH,
      leftCensorCutoffMs: LEFT_CENSOR_CUTOFF_MS,
      costProfiles: CENSUS_COSTS,
    },
    universeSha256,
    counts: {
      contracts: contractsCount,
      leftCensored: leftCensoredCount,
      noKlines: noKlinesCount,
    },
    errors,
    summaries,
    rows: allRows,
  };

  writeFileSync(args.out, JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
