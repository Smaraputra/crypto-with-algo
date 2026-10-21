import { writeFileSync } from 'fs';
import type { FundingRow, PerpCandleRow } from './dataset-format';
import { loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';
import {
  costOf,
  signalsAt,
  staggeredBook as previewStaggeredBook,
  targetBook as previewTargetBook,
} from './nv2-preview';
import {
  computeFund7,
  staggeredBook as liveStaggeredBook,
  targetBook as liveTargetBook,
} from '../../src/lib/signals/lab/v3/f1';
import {
  LAB_HYPOTHESES_V3,
  LAB_V3_UNIVERSE,
  LAB_V3_UNIVERSE_SHA256,
} from '../../src/lib/signals/lab/candidates';
import { gradeBookBar } from '../../src/lib/signals/lab/job-grade';
import { initialEState } from '../../src/lib/signals/lab/e-process';
import { fetchFundingHistory as defaultFetchFundingHistory } from '../../src/lib/snapshot-backfill';
import { settlementTimeOf } from '../../src/lib/funding-settlements';
import type { FundingRate } from '../../src/types/futures';

export const DAY_MS = 86_400_000;
export const SAMPLE_END_DAY = '2026-06-29';

export function toDayMs(val: string | number): number {
  if (typeof val === 'number') return val;
  if (val.includes('T')) return Date.parse(val);
  return Date.parse(`${val}T00:00:00Z`);
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function toMap<T>(v?: Record<string, T> | Map<string, T>): Map<string, T> {
  if (!v) return new Map();
  if (v instanceof Map) return v;
  return new Map(Object.entries(v));
}

function toBookMap(b: Map<string, number> | Record<string, number>): Map<string, number> {
  if (b instanceof Map) return b;
  return new Map(Object.entries(b));
}

function toBookRecord(b: Map<string, number> | Record<string, number>): Record<string, number> {
  if (b instanceof Map) {
    const rec: Record<string, number> = {};
    for (const [k, v] of b.entries()) {
      rec[k] = v;
    }
    return rec;
  }
  return { ...b };
}

export interface BookMismatchExample {
  day: string;
  symbol: string;
  preview: number;
  live: number;
  scoredPreview: number;
  scoredLive: number;
}

export interface CompareBooksInput {
  barsBySymbol?: Record<string, PerpCandleRow[]> | Map<string, PerpCandleRow[]>;
  perpBySymbol?: Record<string, PerpCandleRow[]> | Map<string, PerpCandleRow[]>;
  fundingBySymbol?: Record<string, FundingRow[]> | Map<string, FundingRow[]>;
  startDay: string | number;
  endDay: string | number;
  universe?: readonly string[];

  previewBarsBySymbol?: Record<string, PerpCandleRow[]> | Map<string, PerpCandleRow[]>;
  liveBarsBySymbol?: Record<string, PerpCandleRow[]> | Map<string, PerpCandleRow[]>;
  previewFundingBySymbol?: Record<string, FundingRow[]> | Map<string, FundingRow[]>;
  liveFundingBySymbol?: Record<string, FundingRow[]> | Map<string, FundingRow[]>;
}

export interface CompareBooksResult {
  days: number;
  matching: number;
  mismatches: BookMismatchExample[];
  liveBooks: Array<Map<string, number>>;
  previewBooks: Array<Map<string, number>>;
}

export function compareBooks(input: CompareBooksInput): CompareBooksResult {
  const rawBars = input.barsBySymbol ?? input.perpBySymbol;
  const previewBars = toMap(input.previewBarsBySymbol ?? rawBars);
  const liveBars = toMap(input.liveBarsBySymbol ?? rawBars);

  const rawFunding = input.fundingBySymbol;
  const previewFunding = toMap(input.previewFundingBySymbol ?? rawFunding);
  const liveFunding = toMap(input.liveFundingBySymbol ?? rawFunding);

  const symList = input.universe
    ? Array.from(input.universe)
    : rawBars instanceof Map
      ? Array.from(rawBars.keys())
      : rawBars
        ? Object.keys(rawBars)
        : Array.from(LAB_V3_UNIVERSE);

  const previewBarMap = new Map<string, Map<number, PerpCandleRow>>();
  for (const sym of symList) {
    const m = new Map<number, PerpCandleRow>();
    for (const b of previewBars.get(sym) ?? []) {
      m.set(b.t, b);
    }
    previewBarMap.set(sym, m);
  }

  const liveBarMap = new Map<string, Map<number, PerpCandleRow>>();
  for (const sym of symList) {
    const m = new Map<number, PerpCandleRow>();
    for (const b of liveBars.get(sym) ?? []) {
      m.set(b.t, b);
    }
    liveBarMap.set(sym, m);
  }

  const startMs = toDayMs(input.startDay);
  const endMs = toDayMs(input.endDay);
  const days: number[] = [];
  for (let d = startMs; d <= endMs; d += DAY_MS) {
    days.push(d);
  }

  const previewTargetBooks = new Map<number, Map<string, number>>();
  const liveTargetBooks = new Map<number, Map<string, number>>();
  const scoredPreviewCounts = new Map<number, number>();
  const scoredLiveCounts = new Map<number, number>();

  for (const d of days) {
    const previewEntries: Array<{ symbol: string; score: number }> = [];
    const liveEntries: Array<{ symbol: string; score: number }> = [];

    for (const sym of symList) {
      const pBar = previewBarMap.get(sym)?.get(d);
      if (pBar && pBar.o !== 0) {
        const allBars = previewBars.get(sym) ?? [];
        const settlements = previewFunding.get(sym) ?? [];
        const scores = signalsAt(d, allBars, settlements);
        if (scores.fund7 !== null && Number.isFinite(scores.fund7)) {
          previewEntries.push({ symbol: sym, score: scores.fund7 });
        }
      }

      const lBar = liveBarMap.get(sym)?.get(d);
      if (lBar && lBar.o !== 0) {
        const settlements = liveFunding.get(sym) ?? [];
        const res = computeFund7(
          settlements.map((r) => ({ t: r.t, rate: r.rate })),
          d
        );
        if (res.fund7 !== null && Number.isFinite(res.fund7)) {
          liveEntries.push({ symbol: sym, score: res.fund7 });
        }
      }
    }

    scoredPreviewCounts.set(d, previewEntries.length);
    scoredLiveCounts.set(d, liveEntries.length);

    previewTargetBooks.set(d, previewTargetBook(previewEntries));
    liveTargetBooks.set(d, liveTargetBook(liveEntries));
  }

  const liveBooks: Array<Map<string, number>> = [];
  const previewBooks: Array<Map<string, number>> = [];
  const mismatches: BookMismatchExample[] = [];
  let matching = 0;

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const dateStr = isoDay(d);

    const pastPreview: Array<Map<string, number>> = [];
    const pastLive: Array<Map<string, number>> = [];

    for (let k = 0; k < 7; k++) {
      const pastD = d - k * DAY_MS;
      pastPreview.push(previewTargetBooks.get(pastD) ?? new Map());
      pastLive.push(liveTargetBooks.get(pastD) ?? new Map());
    }

    const currPreview = previewStaggeredBook(pastPreview);
    const currLive = liveStaggeredBook(pastLive);

    previewBooks.push(currPreview);
    liveBooks.push(currLive);

    const allSymbols = new Set<string>([
      ...currPreview.keys(),
      ...currLive.keys(),
    ]);

    let dayMatches = true;
    const dayMismatches: Array<{ sym: string; pW: number; lW: number }> = [];

    for (const sym of allSymbols) {
      const hasP = currPreview.has(sym);
      const hasL = currLive.has(sym);
      const pW = currPreview.get(sym) ?? 0;
      const lW = currLive.get(sym) ?? 0;

      if (!hasP || !hasL || Math.abs(pW - lW) > 1e-12) {
        dayMatches = false;
        dayMismatches.push({ sym, pW, lW });
      }
    }

    if (dayMatches) {
      matching++;
    } else {
      const sp = scoredPreviewCounts.get(d) ?? 0;
      const sl = scoredLiveCounts.get(d) ?? 0;
      for (const dm of dayMismatches) {
        if (mismatches.length < 20) {
          mismatches.push({
            day: dateStr,
            symbol: dm.sym,
            preview: dm.pW,
            live: dm.lW,
            scoredPreview: sp,
            scoredLive: sl,
          });
        }
      }
    }
  }

  return {
    days: days.length,
    matching,
    mismatches,
    liveBooks,
    previewBooks,
  };
}

export interface CostMismatchExample {
  pairIndex: number;
  preview: number;
  live: number;
  diff: number;
}

export interface CostParityResult {
  pairs: number;
  matching: number;
  mismatches: CostMismatchExample[];
}

export function compareCosts(
  booksOrResult: CompareBooksResult | Array<Map<string, number> | Record<string, number>>
): CostParityResult {
  const books: Array<Map<string, number> | Record<string, number>> = Array.isArray(booksOrResult)
    ? booksOrResult
    : booksOrResult.liveBooks;

  const pairsCount = Math.max(0, books.length - 1);
  let matching = 0;
  const mismatches: CostMismatchExample[] = [];

  for (let i = 0; i < pairsCount; i++) {
    const prevMap = toBookMap(books[i]);
    const nextMap = toBookMap(books[i + 1]);
    const prevRec = toBookRecord(books[i]);
    const nextRec = toBookRecord(books[i + 1]);

    const unionSymbols = new Set<string>([
      ...prevMap.keys(),
      ...nextMap.keys(),
    ]);

    let previewCost = 0;
    for (const sym of unionSymbols) {
      const wPrev = prevMap.get(sym) ?? 0;
      const wNext = nextMap.get(sym) ?? 0;
      const traded = Math.abs(wNext - wPrev);
      if (traded > 0) {
        const rankIdx = (LAB_V3_UNIVERSE as readonly string[]).indexOf(sym);
        const rank = rankIdx >= 0 ? rankIdx + 1 : undefined;
        previewCost += costOf(traded, rank);
      }
    }

    const allCoinSymbols = new Set<string>([
      ...Object.keys(nextRec),
      ...Object.keys(prevRec),
      ...LAB_V3_UNIVERSE,
    ]);

    const prices: Record<string, { start: number; end: number }> = {};
    const funding: Record<string, number> = {};
    for (const sym of allCoinSymbols) {
      prices[sym] = { start: 1, end: 1 };
      funding[sym] = 0;
    }

    const gradeRow = gradeBookBar({
      hypothesis: LAB_HYPOTHESES_V3[0],
      barClose: 0,
      late: false,
      scores: nextRec,
      prices,
      funding,
      prev: {
        state: initialEState(),
        weights: prevRec,
      },
      gradedAt: new Date(0),
    });

    const liveCost = -gradeRow.netBookReturn!;
    const diff = Math.abs(previewCost - liveCost);

    if (diff <= 1e-12) {
      matching++;
    } else {
      if (mismatches.length < 20) {
        mismatches.push({
          pairIndex: i,
          preview: previewCost,
          live: liveCost,
          diff,
        });
      }
    }
  }

  return {
    pairs: pairsCount,
    matching,
    mismatches,
  };
}

export interface RestCheckDeps {
  fetchFundingHistory: (symbol: string, startTime: number, endTime: number) => Promise<FundingRate[]>;
  sleep: (ms: number) => Promise<void>;
}

export interface RestCheckOptions {
  from?: string | number;
  to?: string | number;
  archiveFundingBySymbol: Record<string, FundingRow[]> | Map<string, FundingRow[]>;
  symbols?: readonly string[];
}

export interface RestCheckSymbolResult {
  archiveRows: number;
  restRows: number;
  timeMismatches: number;
  rateMismatches: number;
  offsetPrints: number;
}

export async function runRestCheck(
  deps?: Partial<RestCheckDeps>,
  opts?: RestCheckOptions
): Promise<Record<string, RestCheckSymbolResult>> {
  const fetchFunding = deps?.fetchFundingHistory ?? defaultFetchFundingHistory;
  const sleepFn = deps?.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const fromMs = toDayMs(opts?.from ?? '2026-06-01');
  const toMs = toDayMs(opts?.to ?? '2026-06-29');

  const symbols = opts?.symbols ?? LAB_V3_UNIVERSE;
  const archiveMap = toMap(opts?.archiveFundingBySymbol);

  const results: Record<string, RestCheckSymbolResult> = {};

  for (let s = 0; s < symbols.length; s++) {
    if (s > 0) {
      await sleepFn(400);
    }

    const sym = symbols[s];
    let restEvents: FundingRate[];

    try {
      // One minute past the last boundary, as the live job fetches, so a print a few ms late still lands on it
      restEvents = await fetchFunding(sym, fromMs, toMs + 60_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('HTTP 418') || msg.includes('HTTP 429') || msg.includes('-1003')) {
        throw err;
      }
      throw err;
    }

    const archiveRowsForSym = archiveMap.get(sym) ?? [];
    const archiveFiltered = archiveRowsForSym.filter((r) => r.t >= fromMs && r.t <= toMs);
    const archiveByTime = new Map<number, number>();
    for (const r of archiveFiltered) {
      archiveByTime.set(r.t, r.rate);
    }

    let offsetPrints = 0;
    const restByTime = new Map<number, number>();
    let restRowCount = 0;

    for (const event of restEvents) {
      const roundedTime = settlementTimeOf(event.fundingTime);
      if (event.fundingTime !== roundedTime) {
        offsetPrints++;
      }
      if (roundedTime >= fromMs && roundedTime <= toMs) {
        restRowCount++;
        restByTime.set(roundedTime, event.fundingRate);
      }
    }

    const allTimes = new Set<number>([
      ...archiveByTime.keys(),
      ...restByTime.keys(),
    ]);

    let timeMismatches = 0;
    let rateMismatches = 0;

    for (const t of allTimes) {
      const hasArchive = archiveByTime.has(t);
      const hasRest = restByTime.has(t);

      if (!hasArchive || !hasRest) {
        timeMismatches++;
      } else {
        const aRate = archiveByTime.get(t)!;
        const rRate = restByTime.get(t)!;
        if (Math.abs(aRate - rRate) > 1e-12) {
          rateMismatches++;
        }
      }
    }

    results[sym] = {
      archiveRows: archiveFiltered.length,
      restRows: restRowCount,
      timeMismatches,
      rateMismatches,
      offsetPrints,
    };
  }

  return results;
}

export interface ParityV3CliArgs {
  datasetDir: string;
  out: string;
  startDay: string;
  endDay: string;
  skipRest: boolean;
  restFrom: string;
  restTo: string;
}

export function parseArgs(argv: string[]): ParityV3CliArgs {
  let datasetDir: string | null = null;
  let out: string | null = null;
  let startDay = '2021-03-01';
  let endDay = SAMPLE_END_DAY;
  let skipRest = false;
  let restFrom = '2026-06-01';
  let restTo = '2026-06-29';

  let i = 0;
  if (argv.length > 0 && !argv[0].startsWith('--')) {
    i = 1;
  }

  for (; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return v;
    };

    if (flag === '--dataset-dir') {
      datasetDir = value();
    } else if (flag === '--out') {
      out = value();
    } else if (flag === '--start-day') {
      startDay = value();
    } else if (flag === '--end-day') {
      endDay = value();
    } else if (flag === '--skip-rest') {
      skipRest = true;
    } else if (flag === '--rest-from') {
      restFrom = value();
    } else if (flag === '--rest-to') {
      restTo = value();
    } else {
      throw new Error(`Unknown flag "${flag}"`);
    }
  }

  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');

  return {
    datasetDir,
    out,
    startDay,
    endDay,
    skipRest,
    restFrom,
    restTo,
  };
}

export interface ParityReportV3 {
  datasetHash: string;
  universeSha256: string;
  symbolsMissing: string[];
  books: {
    days: number;
    matching: number;
    mismatches: BookMismatchExample[];
  };
  costs: CostParityResult;
  rest: Record<string, RestCheckSymbolResult> | null;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`verifyManifest failed: ${verify.mismatches.join(', ')}`);
  }

  const manifest = loadManifest(args.datasetDir);
  const datasetHash = manifest.datasetHash;

  const barsBySymbol: Record<string, PerpCandleRow[]> = {};
  const fundingBySymbol: Record<string, FundingRow[]> = {};
  const symbolsMissing: string[] = [];

  for (const sym of LAB_V3_UNIVERSE) {
    try {
      const perpRows = loadPerp(args.datasetDir, sym, '1d').rows;
      const fundingRows = loadFunding(args.datasetDir, sym).rows;
      if (perpRows.length === 0) {
        symbolsMissing.push(sym);
      } else {
        barsBySymbol[sym] = perpRows;
        fundingBySymbol[sym] = fundingRows;
      }
    } catch {
      symbolsMissing.push(sym);
    }
  }

  const activeUniverse = LAB_V3_UNIVERSE.filter((s) => !symbolsMissing.includes(s));

  const bookRes = compareBooks({
    barsBySymbol,
    fundingBySymbol,
    startDay: args.startDay,
    endDay: args.endDay,
    universe: activeUniverse,
  });

  const costs = compareCosts(bookRes.liveBooks);

  let rest: Record<string, RestCheckSymbolResult> | null = null;
  if (!args.skipRest) {
    rest = await runRestCheck(undefined, {
      from: args.restFrom,
      to: args.restTo,
      archiveFundingBySymbol: fundingBySymbol,
      symbols: activeUniverse,
    });
  }

  const books = {
    days: bookRes.days,
    matching: bookRes.matching,
    mismatches: bookRes.mismatches,
  };

  const report: ParityReportV3 = {
    datasetHash,
    universeSha256: LAB_V3_UNIVERSE_SHA256,
    symbolsMissing,
    books,
    costs,
    rest,
  };

  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Books: ${books.matching}/${books.days} days match (${books.mismatches.length} mismatches)`);
  console.log(`Costs: ${costs.matching}/${costs.pairs} pairs match (${costs.mismatches.length} mismatches)`);
  if (rest) {
    const syms = Object.keys(rest);
    const totalOffset = syms.reduce((sum, s) => sum + rest[s].offsetPrints, 0);
    const totalTimeMis = syms.reduce((sum, s) => sum + rest[s].timeMismatches, 0);
    const totalRateMis = syms.reduce((sum, s) => sum + rest[s].rateMismatches, 0);
    console.log(`REST: ${syms.length} symbols, ${totalTimeMis} time mismatches, ${totalRateMis} rate mismatches, ${totalOffset} offset prints`);
  } else {
    console.log('REST: skipped');
  }
  if (symbolsMissing.length > 0) {
    console.log(`Missing symbols: ${symbolsMissing.join(', ')}`);
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
