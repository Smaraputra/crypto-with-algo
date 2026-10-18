import { writeFileSync } from 'fs';
import type { CandleRow } from './dataset-format';
import { loadCandles, loadManifest, verifyManifest } from './load-dataset';
import {
  NV1_SYMBOLS,
  assertC2Allowed,
  computeTurnover,
  prepareDataset,
  walkForward,
  type PreparedDataset,
  type WalkForwardWeekResult,
} from './nv1-c2';
import { coinDailySeries, computeDailyValueAreas as researchDailyValueAreas } from './nv1-c3';
import { NV1_SEGMENTS, buildTrades, type CoinSeries, type Trade } from './nv1-core';
import { N2, n2BookAt, type Bar1d } from '../../src/lib/signals/lab/v2/n2';
import {
  N3,
  dailyValueAreas as liveDailyValueAreas,
  n3Position,
  type Bar15,
  type ValueArea as LiveValueArea,
} from '../../src/lib/signals/lab/v2/n3';
import { SIGNAL_SYMBOLS } from '../../src/lib/signals/signal-symbols';
import { rankWeightedCorrelation } from '../../src/lib/stats/rank-ic';
import { fetchKlinesRange } from '../../src/lib/binance';
import { Candle } from '../../src/lib/models/candle';
import { connectDB } from '../../src/lib/mongodb';

export const DAY_MS = 86_400_000;

export function getDaysInRange(startMs: number, endMs: number): number[] {
  const days: number[] = [];
  for (let t = startMs; t < endMs; t += DAY_MS) {
    days.push(t);
  }
  return days;
}

export interface N3MismatchExample {
  symbol: string;
  date: string;
  t: number;
  live: number;
  screen: number;
  kind: 'liveOnly' | 'screenOnly' | 'opposite';
  contiguityOnly?: boolean;
}

export interface N3CoinParityResult {
  days: number;
  agree: number;
  liveOnly: number;
  screenOnly: number;
  opposite: number;
  contiguityOnly: number;
  examples: N3MismatchExample[];
}

export function compareN3ForCoin(
  symbol: string,
  coin: CoinSeries,
  trades: Trade[],
  vas: Map<number, LiveValueArea | null> | ReadonlyMap<number, LiveValueArea | null>,
  days: number[],
  segmentTo: number = NV1_SEGMENTS.C.end
): N3CoinParityResult {
  const tradeByOpenT = new Map<number, Trade>();
  for (const tr of trades) {
    tradeByOpenT.set(tr.openT, tr);
  }

  const coinIndexByT = new Map<number, number>();
  for (let i = 0; i < coin.t.length; i++) {
    coinIndexByT.set(coin.t[i], i);
  }

  let agree = 0;
  let liveOnly = 0;
  let screenOnly = 0;
  let opposite = 0;
  let contiguityOnly = 0;
  const examples: N3MismatchExample[] = [];

  for (const t of days) {
    const livePos = n3Position(vas, t, N3.threshold);
    const screenTrade = tradeByOpenT.get(t);
    const screenPos = screenTrade ? screenTrade.d : 0;
    const date = new Date(t).toISOString().slice(0, 10);

    if (livePos === screenPos) {
      agree++;
    } else if (livePos !== 0 && screenPos === 0) {
      liveOnly++;

      let isContiguityOnly = false;
      const idx = coinIndexByT.get(t);
      if (idx !== undefined) {
        const d = coin.side[idx];
        if (d === livePos) {
          const prevIdx = idx - 1;
          const confirmed =
            prevIdx >= 0 &&
            coin.side[prevIdx] === d &&
            coin.t[idx] - coin.t[prevIdx] === DAY_MS;

          if (confirmed) {
            const nextIdx = idx + 1;
            const nextExists = nextIdx < coin.t.length;
            const nextContiguous =
              nextExists && coin.t[nextIdx] - coin.t[idx] === DAY_MS;
            const insideSegment =
              nextExists && coin.t[nextIdx] < segmentTo;

            if (!nextExists || !nextContiguous || !insideSegment) {
              isContiguityOnly = true;
              contiguityOnly++;
            }
          }
        }
      }

      examples.push({
        symbol,
        date,
        t,
        live: livePos,
        screen: screenPos,
        kind: 'liveOnly',
        contiguityOnly: isContiguityOnly,
      });
    } else if (livePos === 0 && screenPos !== 0) {
      screenOnly++;
      examples.push({
        symbol,
        date,
        t,
        live: livePos,
        screen: screenPos,
        kind: 'screenOnly',
      });
    } else {
      opposite++;
      examples.push({
        symbol,
        date,
        t,
        live: livePos,
        screen: screenPos,
        kind: 'opposite',
      });
    }
  }

  return {
    days: days.length,
    agree,
    liveOnly,
    screenOnly,
    opposite,
    contiguityOnly,
    examples,
  };
}

export interface N2MismatchExample {
  M: number;
  date: string;
  wf: {
    net: number;
    turnover?: number;
    eligible: number;
    cash: boolean;
    incomplete?: boolean;
    ic: number;
  };
  live: {
    net: number;
    turnover: number;
    eligible: number;
    cash: boolean;
    incomplete: boolean;
    ic: number;
  };
  diffs: string[];
}

export interface N2ParityResult {
  weeks: number;
  agree: number;
  mismatches: number;
  examples: N2MismatchExample[];
}

export function compareN2Weeks(
  candlesMappedToBar1d: Record<string, Bar1d[]>,
  researchPrepared: PreparedDataset,
  wfResults: WalkForwardWeekResult[]
): N2ParityResult {
  let agree = 0;
  let mismatches = 0;
  const examples: N2MismatchExample[] = [];

  let prevLiveWeights = new Map<string, number>();

  for (let i = 0; i < wfResults.length; i++) {
    const wf = wfResults[i];
    const M = wf.M;
    const date = new Date(M).toISOString().slice(0, 10);
    const book = n2BookAt(candlesMappedToBar1d, M);

    let net: number;
    let turnover: number;
    let ic: number;
    let liveCash: boolean;
    let liveIncomplete: boolean;
    const eligibleCount = book.eligible.length;

    if (book.cash) {
      liveCash = true;
      liveIncomplete = false;
      const currentWeights = new Map<string, number>();
      turnover = computeTurnover(prevLiveWeights, currentWeights);
      const cost = N2.costRate * turnover;
      net = -cost;
      ic = Number.NaN;
      prevLiveWeights = currentWeights;
    } else {
      let gross = 0;
      const eligibleRawReturns: number[] = [];
      let returnsComplete = true;

      for (const sym of book.eligible) {
        const rawRet = researchPrepared.byM.get(M)?.coinData.get(sym)?.rawForwardReturn;
        if (rawRet === null || rawRet === undefined || !Number.isFinite(rawRet)) {
          returnsComplete = false;
          break;
        }
        eligibleRawReturns.push(rawRet);
        gross += (book.weights[sym] ?? 0) * rawRet;
      }

      if (!returnsComplete) {
        liveCash = false;
        liveIncomplete = true;
        const currentWeights = new Map<string, number>();
        turnover = computeTurnover(prevLiveWeights, currentWeights);
        const cost = N2.costRate * turnover;
        net = -cost;
        ic = Number.NaN;
        prevLiveWeights = currentWeights;
      } else {
        liveCash = false;
        liveIncomplete = false;
        const currentWeights = new Map<string, number>();
        for (const sym of book.eligible) {
          currentWeights.set(sym, book.weights[sym]);
        }
        turnover = computeTurnover(prevLiveWeights, currentWeights);
        const cost = N2.costRate * turnover;
        net = gross - cost;
        const eligiblePreds = book.eligible.map((sym) => book.predictions[sym]);
        ic = rankWeightedCorrelation(eligiblePreds, eligibleRawReturns);
        prevLiveWeights = currentWeights;
      }
    }

    const diffs: string[] = [];

    if (wf.cash !== liveCash) {
      diffs.push(`cash mismatch: wf=${wf.cash}, live=${liveCash}`);
    }
    if (Boolean(wf.incomplete) !== liveIncomplete) {
      diffs.push(`incomplete mismatch: wf=${Boolean(wf.incomplete)}, live=${liveIncomplete}`);
    }

    if (wf.eligible !== eligibleCount) {
      diffs.push(`eligible mismatch: wf=${wf.eligible}, live=${eligibleCount}`);
    }

    const wfTurnover = wf.turnover ?? 0;
    if (Math.abs(wfTurnover - turnover) > 1e-9) {
      diffs.push(`turnover mismatch: wf=${wfTurnover}, live=${turnover}, diff=${Math.abs(wfTurnover - turnover)}`);
    }

    if (Math.abs(wf.net - net) > 1e-9) {
      diffs.push(`net mismatch: wf=${wf.net}, live=${net}, diff=${Math.abs(wf.net - net)}`);
    }

    if (!liveCash && !liveIncomplete) {
      if (Number.isNaN(wf.ic) !== Number.isNaN(ic)) {
        diffs.push(`ic nan mismatch: wf=${wf.ic}, live=${ic}`);
      } else if (!Number.isNaN(wf.ic) && Math.abs(wf.ic - ic) > 1e-9) {
        diffs.push(`ic mismatch: wf=${wf.ic}, live=${ic}, diff=${Math.abs(wf.ic - ic)}`);
      }
    }

    if (diffs.length === 0) {
      agree++;
    } else {
      mismatches++;
      examples.push({
        M,
        date,
        wf: {
          net: wf.net,
          turnover: wf.turnover,
          eligible: wf.eligible,
          cash: wf.cash,
          incomplete: Boolean(wf.incomplete),
          ic: wf.ic,
        },
        live: {
          net,
          turnover,
          eligible: eligibleCount,
          cash: liveCash,
          incomplete: liveIncomplete,
          ic,
        },
        diffs,
      });
    }
  }

  return {
    weeks: wfResults.length,
    agree,
    mismatches,
    examples: examples.slice(0, 20),
  };
}

export interface ParityReport {
  datasetHash: string;
  n3: {
    coins: number;
    days: number;
    agree: number;
    liveOnly: number;
    screenOnly: number;
    opposite: number;
    contiguityOnly: number;
    examples: N3MismatchExample[];
  };
  n2: {
    weeks: number;
    agree: number;
    mismatches: number;
    examples: N2MismatchExample[];
  };
}

export async function runParity(datasetDir: string): Promise<ParityReport> {
  assertC2Allowed(__dirname);

  const verify = await verifyManifest(datasetDir);
  if (!verify.ok) {
    throw new Error(`verifyManifest failed: ${verify.mismatches.join(', ')}`);
  }

  const manifest = loadManifest(datasetDir);
  const datasetHash = manifest.datasetHash;

  // 1. N3 parity
  const allDays = getDaysInRange(NV1_SEGMENTS.B.start, NV1_SEGMENTS.C.end);
  let n3TotalAgree = 0;
  let n3TotalLiveOnly = 0;
  let n3TotalScreenOnly = 0;
  let n3TotalOpposite = 0;
  let n3TotalContiguityOnly = 0;
  let n3TotalDays = 0;
  const n3AllExamples: N3MismatchExample[] = [];

  for (const sym of NV1_SYMBOLS) {
    const c15m = loadCandles(datasetDir, sym, '15m', {
      allowHoldoutA: false,
      allowLockbox: false,
    }).rows;

    const c1d = loadCandles(datasetDir, sym, '1d', {
      allowHoldoutA: false,
      allowLockbox: false,
    }).rows.filter((c) => c.t >= NV1_SEGMENTS.B.start && c.t < NV1_SEGMENTS.C.end);

    const screenVaMap = researchDailyValueAreas(c15m);
    const coin = coinDailySeries(sym, screenVaMap, c1d, N3.threshold);
    const trades = buildTrades(coin, {
      k: 1,
      hold: 1,
      stepMs: DAY_MS,
      costPct: 0.14,
      from: NV1_SEGMENTS.B.start,
      to: NV1_SEGMENTS.C.end,
    });

    const bars15: Bar15[] = c15m.map((c) => ({
      t: c.t,
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
      v: c.v,
    }));
    const liveVas = liveDailyValueAreas(bars15);

    const coinRes = compareN3ForCoin(sym, coin, trades, liveVas, allDays, NV1_SEGMENTS.C.end);
    n3TotalDays += coinRes.days;
    n3TotalAgree += coinRes.agree;
    n3TotalLiveOnly += coinRes.liveOnly;
    n3TotalScreenOnly += coinRes.screenOnly;
    n3TotalOpposite += coinRes.opposite;
    n3TotalContiguityOnly += coinRes.contiguityOnly;
    n3AllExamples.push(...coinRes.examples);
  }

  // 2. N2 parity
  const candles1dBySymbol: Record<string, CandleRow[]> = {};
  const candlesMappedToBar1d: Record<string, Bar1d[]> = {};

  for (const sym of NV1_SYMBOLS) {
    const rows = loadCandles(datasetDir, sym, '1d', {
      allowHoldoutA: true,
      allowLockbox: false,
    }).rows;
    candles1dBySymbol[sym] = rows;
    candlesMappedToBar1d[sym] = rows.map((c) => ({
      t: c.t,
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
      v: c.v,
      tbv: c.tbv === null ? undefined : c.tbv,
    }));
  }

  const prepared = prepareDataset(candles1dBySymbol);
  const wfResults = walkForward(prepared, N2.lookbackWeeks, N2.k);
  const n2Res = compareN2Weeks(candlesMappedToBar1d, prepared, wfResults);

  return {
    datasetHash,
    n3: {
      coins: NV1_SYMBOLS.length,
      days: n3TotalDays,
      agree: n3TotalAgree,
      liveOnly: n3TotalLiveOnly,
      screenOnly: n3TotalScreenOnly,
      opposite: n3TotalOpposite,
      contiguityOnly: n3TotalContiguityOnly,
      examples: n3AllExamples.slice(0, 20),
    },
    n2: {
      weeks: n2Res.weeks,
      agree: n2Res.agree,
      mismatches: n2Res.mismatches,
      examples: n2Res.examples,
    },
  };
}

export interface CandleDiffMetrics {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
}

export interface RestCheckItemResult {
  symbol: string;
  interval: string;
  restCount: number;
  storedCount: number;
  matchedCount: number;
  restOnlyCount: number;
  storedOnlyCount: number;
  maxDiff: CandleDiffMetrics;
}

export function compareCandleSets(
  symbol: string,
  interval: string,
  restCandles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    takerBuyVolume?: number;
  }>,
  storedCandles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    takerBuyVolume?: number | null;
  }>
): RestCheckItemResult {
  const restMap = new Map<number, (typeof restCandles)[0]>();
  for (const c of restCandles) {
    restMap.set(c.timestamp, c);
  }

  const storedMap = new Map<number, (typeof storedCandles)[0]>();
  for (const c of storedCandles) {
    storedMap.set(c.timestamp, c);
  }

  const allTimestamps = new Set<number>([
    ...restMap.keys(),
    ...storedMap.keys(),
  ]);

  let matchedCount = 0;
  let restOnlyCount = 0;
  let storedOnlyCount = 0;

  let maxDiffOpen = 0;
  let maxDiffHigh = 0;
  let maxDiffLow = 0;
  let maxDiffClose = 0;
  let maxDiffVolume = 0;
  let maxDiffTakerBuyVolume = 0;

  for (const t of allTimestamps) {
    const r = restMap.get(t);
    const s = storedMap.get(t);

    if (r && !s) {
      restOnlyCount++;
    } else if (!r && s) {
      storedOnlyCount++;
    } else if (r && s) {
      matchedCount++;
      maxDiffOpen = Math.max(maxDiffOpen, Math.abs(r.open - s.open));
      maxDiffHigh = Math.max(maxDiffHigh, Math.abs(r.high - s.high));
      maxDiffLow = Math.max(maxDiffLow, Math.abs(r.low - s.low));
      maxDiffClose = Math.max(maxDiffClose, Math.abs(r.close - s.close));
      maxDiffVolume = Math.max(maxDiffVolume, Math.abs(r.volume - s.volume));

      const rTbv = r.takerBuyVolume;
      const sTbv = s.takerBuyVolume;
      if (
        rTbv !== undefined &&
        Number.isFinite(rTbv) &&
        sTbv !== undefined &&
        sTbv !== null &&
        Number.isFinite(sTbv)
      ) {
        maxDiffTakerBuyVolume = Math.max(
          maxDiffTakerBuyVolume,
          Math.abs(rTbv - sTbv)
        );
      }
    }
  }

  return {
    symbol,
    interval,
    restCount: restCandles.length,
    storedCount: storedCandles.length,
    matchedCount,
    restOnlyCount,
    storedOnlyCount,
    maxDiff: {
      open: maxDiffOpen,
      high: maxDiffHigh,
      low: maxDiffLow,
      close: maxDiffClose,
      volume: maxDiffVolume,
      takerBuyVolume: maxDiffTakerBuyVolume,
    },
  };
}

export interface RestCheckReport {
  generatedAt: string;
  days: number;
  startTime: number;
  endTime: number;
  startDate: string;
  endDate: string;
  results: RestCheckItemResult[];
}

export async function runRestCheck(days: number = 60): Promise<RestCheckReport> {
  await connectDB();

  const now = Date.now();
  const todayMidnight = Math.floor(now / DAY_MS) * DAY_MS;
  const startTime = todayMidnight - days * DAY_MS;
  const endTime = todayMidnight;

  const results: RestCheckItemResult[] = [];
  const intervals = ['1d', '15m'] as const;

  for (const sym of SIGNAL_SYMBOLS) {
    for (const interval of intervals) {
      const restKlines = await fetchKlinesRange(sym, interval, startTime, endTime - 1);
      const restFiltered = restKlines.filter(
        (c) => c.timestamp >= startTime && c.timestamp < endTime
      );

      const storedCandles = await Candle.find({
        symbol: sym,
        interval,
        timestamp: { $gte: startTime, $lt: endTime },
      }).lean();

      const itemRes = compareCandleSets(sym, interval, restFiltered, storedCandles);
      results.push(itemRes);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    days,
    startTime,
    endTime,
    startDate: new Date(startTime).toISOString().slice(0, 10),
    endDate: new Date(endTime).toISOString().slice(0, 10),
    results,
  };
}

export interface ParityCliArgs {
  command: 'parity';
  datasetDir: string;
  out: string;
}

export interface RestCheckCliArgs {
  command: 'rest-check';
  days: number;
  out: string;
}

export type CliArgs = ParityCliArgs | RestCheckCliArgs;

export function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0) {
    throw new Error('No command specified. Expected "parity" or "rest-check".');
  }

  const command = argv[0];
  if (command === 'parity') {
    let datasetDir: string | null = null;
    let out: string | null = null;

    for (let i = 1; i < argv.length; i++) {
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
      } else {
        throw new Error(`Unknown flag "${flag}" for parity command`);
      }
    }

    if (!datasetDir) throw new Error('--dataset-dir is required');
    if (!out) throw new Error('--out is required');

    return { command: 'parity', datasetDir, out };
  }

  if (command === 'rest-check') {
    let days = 60;
    let out: string | null = null;

    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      const value = (): string => {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) {
          throw new Error(`${flag} requires a value`);
        }
        return v;
      };

      if (flag === '--days') {
        days = Number.parseInt(value(), 10);
        if (!Number.isFinite(days) || days <= 0) {
          throw new Error('--days must be a positive integer');
        }
      } else if (flag === '--out') {
        out = value();
      } else {
        throw new Error(`Unknown flag "${flag}" for rest-check command`);
      }
    }

    if (!out) throw new Error('--out is required');

    return { command: 'rest-check', days, out };
  }

  throw new Error(`Unknown command "${command}". Expected "parity" or "rest-check".`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === 'parity') {
    const report = await runParity(args.datasetDir);
    writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report));
    return;
  }
  if (args.command === 'rest-check') {
    const report = await runRestCheck(args.days);
    writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report));
    return;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
