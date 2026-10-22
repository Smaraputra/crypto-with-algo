import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fetchPerpKlinesOhlcv } from '../../src/lib/binance-futures';
import {
  HOUR_MS,
  LAB_V4_WINDOW_BARS,
  s1SideAtLast,
  s2SideAtLast,
  type Side,
} from '../../src/lib/signals/lab/v4/rules';
import { SIGNAL_SYMBOLS } from '../../src/lib/signals/signal-symbols';
import type { OHLCV } from '../../src/types/market';
import {
  c1Signals,
  c2Signals,
  ROUND_TRIP_COST,
  tradesFor,
  type Signal,
  type Trade,
} from './lab-v4-preview';
import { loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';

export { HOUR_MS, LAB_V4_WINDOW_BARS, ROUND_TRIP_COST };

export interface SignalMismatchExample {
  t: number;
  timestamp: number;
  live: number;
  preview: number;
}

export interface RuleSignalParityResult {
  bars: number;
  agree: number;
  liveOnly: number;
  previewOnly: number;
  opposite: number;
  examples: SignalMismatchExample[];
}

export interface CompareSignalsResult {
  S1: RuleSignalParityResult;
  S2: RuleSignalParityResult;
}

export interface CompareSignalsDeps {
  s1Fn?: (closed: readonly OHLCV[]) => Side;
  s2Fn?: (closed: readonly OHLCV[]) => Side;
  c1Fn?: (bars: readonly OHLCV[]) => Signal[];
  c2Fn?: (bars: readonly OHLCV[]) => Signal[];
}

/**
 * Compares live S1/S2 rules evaluated over a trailing window against preview C1/C2 signals.
 * For every index t from window - 1 to bars.length - 1:
 * - live side is s1SideAtLast(bars.slice(t - window + 1, t + 1));
 * - preview side is c1Signals(bars) at index t, or 0 if none;
 * - for S2, when the preview has two signals at the same index, its side at t is the FIRST in c2Signals order.
 */
export function compareSignals(
  bars: readonly OHLCV[],
  window: number = LAB_V4_WINDOW_BARS,
  deps?: CompareSignalsDeps
): CompareSignalsResult {
  const s1Fn = deps?.s1Fn ?? s1SideAtLast;
  const s2Fn = deps?.s2Fn ?? s2SideAtLast;
  const c1Fn = deps?.c1Fn ?? c1Signals;
  const c2Fn = deps?.c2Fn ?? c2Signals;

  const previewC1Signals = c1Fn(bars);
  const previewC2Signals = c2Fn(bars);

  const previewC1Map = new Map<number, number>();
  for (const sig of previewC1Signals) {
    if (!previewC1Map.has(sig.index)) {
      previewC1Map.set(sig.index, sig.side);
    }
  }

  const previewC2Map = new Map<number, number>();
  for (const sig of previewC2Signals) {
    if (!previewC2Map.has(sig.index)) {
      previewC2Map.set(sig.index, sig.side);
    }
  }

  let s1Bars = 0;
  let s1Agree = 0;
  let s1LiveOnly = 0;
  let s1PreviewOnly = 0;
  let s1Opposite = 0;
  const s1Examples: SignalMismatchExample[] = [];

  let s2Bars = 0;
  let s2Agree = 0;
  let s2LiveOnly = 0;
  let s2PreviewOnly = 0;
  let s2Opposite = 0;
  const s2Examples: SignalMismatchExample[] = [];

  for (let t = window - 1; t < bars.length; t++) {
    const windowSlice = bars.slice(t - window + 1, t + 1);
    const timestamp = bars[t].timestamp;

    // S1
    const liveS1 = s1Fn(windowSlice);
    const previewS1 = previewC1Map.get(t) ?? 0;
    s1Bars++;
    if (liveS1 === previewS1) {
      s1Agree++;
    } else if (liveS1 !== 0 && previewS1 === 0) {
      s1LiveOnly++;
      if (s1Examples.length < 10) {
        s1Examples.push({ t, timestamp, live: liveS1, preview: previewS1 });
      }
    } else if (liveS1 === 0 && previewS1 !== 0) {
      s1PreviewOnly++;
      if (s1Examples.length < 10) {
        s1Examples.push({ t, timestamp, live: liveS1, preview: previewS1 });
      }
    } else {
      s1Opposite++;
      if (s1Examples.length < 10) {
        s1Examples.push({ t, timestamp, live: liveS1, preview: previewS1 });
      }
    }

    // S2
    const liveS2 = s2Fn(windowSlice);
    const previewS2 = previewC2Map.get(t) ?? 0;
    s2Bars++;
    if (liveS2 === previewS2) {
      s2Agree++;
    } else if (liveS2 !== 0 && previewS2 === 0) {
      s2LiveOnly++;
      if (s2Examples.length < 10) {
        s2Examples.push({ t, timestamp, live: liveS2, preview: previewS2 });
      }
    } else if (liveS2 === 0 && previewS2 !== 0) {
      s2PreviewOnly++;
      if (s2Examples.length < 10) {
        s2Examples.push({ t, timestamp, live: liveS2, preview: previewS2 });
      }
    } else {
      s2Opposite++;
      if (s2Examples.length < 10) {
        s2Examples.push({ t, timestamp, live: liveS2, preview: previewS2 });
      }
    }
  }

  return {
    S1: {
      bars: s1Bars,
      agree: s1Agree,
      liveOnly: s1LiveOnly,
      previewOnly: s1PreviewOnly,
      opposite: s1Opposite,
      examples: s1Examples,
    },
    S2: {
      bars: s2Bars,
      agree: s2Agree,
      liveOnly: s2LiveOnly,
      previewOnly: s2PreviewOnly,
      opposite: s2Opposite,
      examples: s2Examples,
    },
  };
}

export interface RuleTradeParityResult {
  previewTrades: number;
  liveTrades: number;
  matched: number;
  onlyPreview: number;
  onlyLive: number;
}

export interface CompareTradesResult {
  S1: RuleTradeParityResult;
  S2: RuleTradeParityResult;
}

/**
 * Builds live trades from per-bar sides or signals by applying the live job's rule:
 * - A signal at bar s is ignored if the same rule's previous TAKEN signal is fewer than 8 bars earlier (s - s_prev < 8).
 * - Only bars with a contiguous next bar and a contiguous hold (8 bars) are traded.
 */
export function buildLiveTrades(
  bars: readonly OHLCV[],
  settlements: readonly { t: number; rate: number }[],
  signalsOrSides: readonly Signal[] | readonly number[]
): Trade[] {
  let sigList: Signal[];
  if (signalsOrSides.length > 0 && typeof signalsOrSides[0] === 'number') {
    sigList = [];
    for (let i = 0; i < signalsOrSides.length; i++) {
      const s = signalsOrSides[i] as number;
      if (s !== 0 && Number.isFinite(s)) {
        sigList.push({ index: i, side: s });
      }
    }
  } else {
    sigList = (signalsOrSides as Signal[]).slice();
  }

  sigList.sort((a, b) => a.index - b.index);

  const dedupedSignals: Signal[] = [];
  const seenIndex = new Set<number>();
  for (const sig of sigList) {
    if (!seenIndex.has(sig.index)) {
      seenIndex.add(sig.index);
      dedupedSignals.push(sig);
    }
  }

  const trades: Trade[] = [];
  let sPrev = -1;

  for (const sig of dedupedSignals) {
    const s = sig.index;
    if (sPrev !== -1 && s - sPrev < 8) {
      continue;
    }

    const entryIndex = s + 1;
    const exitIndex = s + 9;

    if (s < 0 || entryIndex >= bars.length || exitIndex >= bars.length) {
      continue;
    }
    const signalBar = bars[s];
    const entryBar = bars[entryIndex];
    const exitBar = bars[exitIndex];
    if (!signalBar || !entryBar || !exitBar) {
      continue;
    }

    if (
      entryBar.timestamp !== signalBar.timestamp + HOUR_MS ||
      exitBar.timestamp !== entryBar.timestamp + 8 * HOUR_MS
    ) {
      continue;
    }

    const entryPrice = entryBar.open;
    const exitPrice = exitBar.open;
    if (entryPrice <= 0 || !Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) {
      continue;
    }

    const entryTime = entryBar.timestamp;
    const exitTime = exitBar.timestamp;
    const r = exitPrice / entryPrice - 1;

    let funding = 0;
    for (let i = 0; i < settlements.length; i++) {
      const settlement = settlements[i];
      if (settlement.t > entryTime && settlement.t <= exitTime) {
        funding += settlement.rate;
      }
    }

    const net = sig.side * r - sig.side * funding - ROUND_TRIP_COST;

    trades.push({
      entryTime,
      exitTime,
      side: sig.side,
      r,
      funding,
      net,
    });

    sPrev = s;
  }

  return trades;
}

export function compareTradeLists(
  previewTrades: readonly Trade[],
  liveTrades: readonly Trade[]
): RuleTradeParityResult {
  const previewMap = new Map<number, number>();
  for (const tr of previewTrades) {
    previewMap.set(tr.entryTime, tr.side);
  }

  const liveMap = new Map<number, number>();
  for (const tr of liveTrades) {
    liveMap.set(tr.entryTime, tr.side);
  }

  let matched = 0;
  let onlyPreview = 0;
  let onlyLive = 0;

  for (const [entryTime, previewSide] of previewMap.entries()) {
    const liveSide = liveMap.get(entryTime);
    if (liveSide !== undefined && liveSide === previewSide) {
      matched++;
    } else {
      onlyPreview++;
    }
  }

  for (const [entryTime, liveSide] of liveMap.entries()) {
    const previewSide = previewMap.get(entryTime);
    if (previewSide === undefined || previewSide !== liveSide) {
      onlyLive++;
    }
  }

  return {
    previewTrades: previewTrades.length,
    liveTrades: liveTrades.length,
    matched,
    onlyPreview,
    onlyLive,
  };
}

export interface CompareTradesOptions {
  window?: number;
  liveSignalsS1?: readonly Signal[];
  liveSignalsS2?: readonly Signal[];
  previewSignalsS1?: readonly Signal[];
  previewSignalsS2?: readonly Signal[];
  signalsS1?: readonly Signal[];
  signalsS2?: readonly Signal[];
  s1SideAtLastFn?: (closed: readonly OHLCV[]) => Side;
  s2SideAtLastFn?: (closed: readonly OHLCV[]) => Side;
}

/**
 * Builds live trades from live per-bar sides by applying the live job's rule:
 * - Signal at bar s is ignored if previous TAKEN signal was fewer than 8 bars earlier (s - s_prev < 8).
 * - Only bars with a contiguous next bar and a contiguous hold are traded.
 * Compares entry times and sides with tradesFor(bars, settlements, c1Signals(bars)), and the same for S2.
 */
export function compareTrades(
  bars: readonly OHLCV[],
  settlements: readonly { t: number; rate: number }[],
  opts?: CompareTradesOptions
): CompareTradesResult {
  const window = opts?.window ?? LAB_V4_WINDOW_BARS;
  const s1Fn = opts?.s1SideAtLastFn ?? s1SideAtLast;
  const s2Fn = opts?.s2SideAtLastFn ?? s2SideAtLast;

  const previewS1 = opts?.signalsS1 ?? opts?.previewSignalsS1 ?? c1Signals(bars);
  const previewS2 = opts?.signalsS2 ?? opts?.previewSignalsS2 ?? c2Signals(bars);

  let liveS1: readonly Signal[];
  if (opts?.signalsS1) {
    liveS1 = opts.signalsS1;
  } else if (opts?.liveSignalsS1) {
    liveS1 = opts.liveSignalsS1;
  } else {
    const sigs: Signal[] = [];
    for (let t = window - 1; t < bars.length; t++) {
      const windowSlice = bars.slice(t - window + 1, t + 1);
      const side = s1Fn(windowSlice);
      if (side !== 0) {
        sigs.push({ index: t, side });
      }
    }
    liveS1 = sigs;
  }

  let liveS2: readonly Signal[];
  if (opts?.signalsS2) {
    liveS2 = opts.signalsS2;
  } else if (opts?.liveSignalsS2) {
    liveS2 = opts.liveSignalsS2;
  } else {
    const sigs: Signal[] = [];
    for (let t = window - 1; t < bars.length; t++) {
      const windowSlice = bars.slice(t - window + 1, t + 1);
      const side = s2Fn(windowSlice);
      if (side !== 0) {
        sigs.push({ index: t, side });
      }
    }
    liveS2 = sigs;
  }

  const pTrades1 = tradesFor(bars, settlements, previewS1);
  const lTrades1 = buildLiveTrades(bars, settlements, liveS1);

  const pTrades2 = tradesFor(bars, settlements, previewS2);
  const lTrades2 = buildLiveTrades(bars, settlements, liveS2);

  return {
    S1: compareTradeLists(pTrades1, lTrades1),
    S2: compareTradeLists(pTrades2, lTrades2),
  };
}

export interface RestCheckDeps {
  fetchPerpKlinesOhlcv: (
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number
  ) => Promise<OHLCV[]>;
  sleep: (ms: number) => Promise<void>;
}

export interface RestCheckOptions {
  from?: string | number;
  to?: string | number;
  archiveBarsBySymbol?: Record<string, readonly OHLCV[]> | Map<string, readonly OHLCV[]>;
  symbols?: readonly string[];
}

export interface RestCheckSymbolResult {
  archiveBars: number;
  restBars: number;
  timeMismatches: number;
  fieldMismatches: number;
}

export function parseRangeBound(val: string | number, isStart: boolean): number {
  if (typeof val === 'number') return val;
  if (val.includes('T')) return Date.parse(val);
  const suffix = isStart ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
  return Date.parse(`${val}${suffix}`);
}

export function isFieldMismatch(
  a: number | undefined | null,
  b: number | undefined | null
): boolean {
  if (a === b) return false;
  if (a === undefined || a === null || b === undefined || b === null) {
    return true;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return a !== b;
  }
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return false;
  const relDiff = Math.abs(a - b) / max;
  return relDiff > 1e-9;
}

async function fetchAllBars(
  fetchFn: RestCheckDeps['fetchPerpKlinesOhlcv'],
  symbol: string,
  startTime: number,
  endTime: number
): Promise<OHLCV[]> {
  const allBars: OHLCV[] = [];
  let cur = startTime;
  while (cur <= endTime) {
    const page = await fetchFn(symbol, '1h', 1000, cur, endTime);
    if (!page || page.length === 0) break;
    allBars.push(...page);
    if (page.length < 1000) break;
    const lastTime = page[page.length - 1].timestamp;
    if (lastTime >= endTime) break;
    const nextCur = lastTime + HOUR_MS;
    if (nextCur <= cur) break;
    cur = nextCur;
  }
  return allBars;
}

/**
 * Sequentially fetches perp 1h bars by REST for each symbol, comparing with archive bars.
 * Aborts immediately on HTTP 418, HTTP 429 or -1003. Never retries.
 */
export async function runRestCheck(
  deps?: Partial<RestCheckDeps>,
  opts?: RestCheckOptions
): Promise<Record<string, RestCheckSymbolResult>> {
  const fetchFn = deps?.fetchPerpKlinesOhlcv ?? fetchPerpKlinesOhlcv;
  const sleepFn =
    deps?.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const fromVal = opts?.from ?? '2026-06-01';
  const toVal = opts?.to ?? '2026-06-29';

  const fromMs = parseRangeBound(fromVal, true);
  const toMs = parseRangeBound(toVal, false);

  const symbols = opts?.symbols ?? SIGNAL_SYMBOLS;
  const archiveMap = opts?.archiveBarsBySymbol
    ? opts.archiveBarsBySymbol instanceof Map
      ? opts.archiveBarsBySymbol
      : new Map(Object.entries(opts.archiveBarsBySymbol))
    : new Map<string, readonly OHLCV[]>();

  const results: Record<string, RestCheckSymbolResult> = {};

  for (let s = 0; s < symbols.length; s++) {
    if (s > 0) {
      await sleepFn(400);
    }

    const sym = symbols[s];
    let restBarsRaw: OHLCV[];

    try {
      restBarsRaw = await fetchAllBars(fetchFn, sym, fromMs, toMs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('HTTP 418') || msg.includes('HTTP 429') || msg.includes('-1003')) {
        throw err;
      }
      throw err;
    }

    const restMap = new Map<number, OHLCV>();
    for (const b of restBarsRaw) {
      if (b.timestamp >= fromMs && b.timestamp <= toMs) {
        restMap.set(b.timestamp, b);
      }
    }

    const archiveList = (archiveMap.get(sym) ?? []).filter(
      (b) => b.timestamp >= fromMs && b.timestamp <= toMs
    );
    const archiveByTime = new Map<number, OHLCV>();
    for (const b of archiveList) {
      archiveByTime.set(b.timestamp, b);
    }

    const allTimes = new Set<number>([
      ...archiveByTime.keys(),
      ...restMap.keys(),
    ]);

    let timeMismatches = 0;
    let fieldMismatches = 0;

    for (const t of allTimes) {
      const aBar = archiveByTime.get(t);
      const rBar = restMap.get(t);

      if (!aBar || !rBar) {
        timeMismatches++;
      } else {
        const fields: (keyof Pick<
          OHLCV,
          'open' | 'high' | 'low' | 'close' | 'volume' | 'takerBuyVolume'
        >)[] = ['open', 'high', 'low', 'close', 'volume', 'takerBuyVolume'];

        for (const f of fields) {
          const aVal = aBar[f];
          const rVal = rBar[f];
          if (isFieldMismatch(aVal, rVal)) {
            fieldMismatches++;
          }
        }
      }
    }

    results[sym] = {
      archiveBars: archiveList.length,
      restBars: restMap.size,
      timeMismatches,
      fieldMismatches,
    };
  }

  return results;
}

export interface ParityV4CliArgs {
  datasetDir: string;
  out: string;
  from: string;
  to: string;
  skipRest: boolean;
  restFrom: string;
  restTo: string;
}

export function parseArgs(argv: string[]): ParityV4CliArgs {
  let datasetDir = '';
  let out = '';
  let from = '2022-01-01';
  let to = '2026-06-30';
  let skipRest = false;
  let restFrom = '2026-06-01';
  let restTo = '2026-06-29';

  let i = 0;
  if (argv.length > 0 && !argv[0].startsWith('--')) {
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset-dir' && i + 1 < argv.length) {
      datasetDir = argv[++i];
    } else if (arg.startsWith('--dataset-dir=')) {
      datasetDir = arg.slice('--dataset-dir='.length);
    } else if (arg === '--out' && i + 1 < argv.length) {
      out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--from' && i + 1 < argv.length) {
      from = argv[++i];
    } else if (arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
    } else if (arg === '--to' && i + 1 < argv.length) {
      to = argv[++i];
    } else if (arg.startsWith('--to=')) {
      to = arg.slice('--to='.length);
    } else if (arg === '--skip-rest') {
      skipRest = true;
    } else if (arg === '--rest-from' && i + 1 < argv.length) {
      restFrom = argv[++i];
    } else if (arg.startsWith('--rest-from=')) {
      restFrom = arg.slice('--rest-from='.length);
    } else if (arg === '--rest-to' && i + 1 < argv.length) {
      restTo = argv[++i];
    } else if (arg.startsWith('--rest-to=')) {
      restTo = arg.slice('--rest-to='.length);
    } else {
      throw new Error(`Unknown flag "${arg}"`);
    }
  }

  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');

  return {
    datasetDir,
    out,
    from,
    to,
    skipRest,
    restFrom,
    restTo,
  };
}

export interface RuleParityTotal {
  bars: number;
  agree: number;
  liveOnly: number;
  previewOnly: number;
  opposite: number;
  previewTrades: number;
  liveTrades: number;
  matched: number;
  onlyPreview: number;
  onlyLive: number;
}

export interface SymbolRuleParityResult extends RuleSignalParityResult, RuleTradeParityResult {
  signals: RuleSignalParityResult;
  trades: RuleTradeParityResult;
}

export interface SymbolParityResult {
  S1: SymbolRuleParityResult;
  S2: SymbolRuleParityResult;
}

export interface ParityReportV4 {
  datasetHash: string;
  from: string;
  to: string;
  perSymbol: Record<string, SymbolParityResult>;
  totals: {
    S1: RuleParityTotal;
    S2: RuleParityTotal;
  };
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

  const fromMs = parseRangeBound(args.from, true);
  const toMs = parseRangeBound(args.to, false);

  const barsBySymbol: Record<string, OHLCV[]> = {};
  const fundingBySymbol: Record<string, { t: number; rate: number }[]> = {};

  for (const sym of SIGNAL_SYMBOLS) {
    const perpResult = loadPerp(args.datasetDir, sym, '1h');
    const fundingResult = loadFunding(args.datasetDir, sym);

    const mappedBars: OHLCV[] = perpResult.rows
      .filter((r) => r.t >= fromMs && r.t <= toMs)
      .map((row) => ({
        timestamp: row.t,
        open: row.o,
        high: row.h,
        low: row.l,
        close: row.c,
        volume: row.v,
        takerBuyVolume: row.tbv ?? undefined,
      }));

    const mappedFunding = fundingResult.rows
      .filter((r) => r.t >= fromMs && r.t <= toMs)
      .map((r) => ({ t: r.t, rate: r.rate }));

    barsBySymbol[sym] = mappedBars;
    fundingBySymbol[sym] = mappedFunding;
  }

  const perSymbol: Record<string, SymbolParityResult> = {};
  const totals = {
    S1: {
      bars: 0,
      agree: 0,
      liveOnly: 0,
      previewOnly: 0,
      opposite: 0,
      previewTrades: 0,
      liveTrades: 0,
      matched: 0,
      onlyPreview: 0,
      onlyLive: 0,
    },
    S2: {
      bars: 0,
      agree: 0,
      liveOnly: 0,
      previewOnly: 0,
      opposite: 0,
      previewTrades: 0,
      liveTrades: 0,
      matched: 0,
      onlyPreview: 0,
      onlyLive: 0,
    },
  };

  for (const sym of SIGNAL_SYMBOLS) {
    const bars = barsBySymbol[sym] ?? [];
    const settlements = fundingBySymbol[sym] ?? [];

    const signals = compareSignals(bars);
    const trades = compareTrades(bars, settlements);

    perSymbol[sym] = {
      S1: {
        signals: signals.S1,
        trades: trades.S1,
        ...signals.S1,
        ...trades.S1,
      },
      S2: {
        signals: signals.S2,
        trades: trades.S2,
        ...signals.S2,
        ...trades.S2,
      },
    };

    totals.S1.bars += signals.S1.bars;
    totals.S1.agree += signals.S1.agree;
    totals.S1.liveOnly += signals.S1.liveOnly;
    totals.S1.previewOnly += signals.S1.previewOnly;
    totals.S1.opposite += signals.S1.opposite;
    totals.S1.previewTrades += trades.S1.previewTrades;
    totals.S1.liveTrades += trades.S1.liveTrades;
    totals.S1.matched += trades.S1.matched;
    totals.S1.onlyPreview += trades.S1.onlyPreview;
    totals.S1.onlyLive += trades.S1.onlyLive;

    totals.S2.bars += signals.S2.bars;
    totals.S2.agree += signals.S2.agree;
    totals.S2.liveOnly += signals.S2.liveOnly;
    totals.S2.previewOnly += signals.S2.previewOnly;
    totals.S2.opposite += signals.S2.opposite;
    totals.S2.previewTrades += trades.S2.previewTrades;
    totals.S2.liveTrades += trades.S2.liveTrades;
    totals.S2.matched += trades.S2.matched;
    totals.S2.onlyPreview += trades.S2.onlyPreview;
    totals.S2.onlyLive += trades.S2.onlyLive;
  }

  let rest: Record<string, RestCheckSymbolResult> | null = null;
  if (!args.skipRest) {
    rest = await runRestCheck(undefined, {
      from: args.restFrom,
      to: args.restTo,
      archiveBarsBySymbol: barsBySymbol,
      symbols: SIGNAL_SYMBOLS,
    });
  }

  const report: ParityReportV4 = {
    datasetHash,
    from: args.from,
    to: args.to,
    perSymbol,
    totals,
    rest,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');

  const s1Pct = totals.S1.bars > 0 ? ((totals.S1.agree / totals.S1.bars) * 100).toFixed(2) : '100.00';
  const s2Pct = totals.S2.bars > 0 ? ((totals.S2.agree / totals.S2.bars) * 100).toFixed(2) : '100.00';

  console.log(
    `S1: ${totals.S1.agree}/${totals.S1.bars} bars agree (${s1Pct}%), ` +
      `${totals.S1.matched}/${totals.S1.previewTrades} preview trades matched, ` +
      `${totals.S1.liveTrades} live trades (${totals.S1.onlyPreview} onlyPreview, ${totals.S1.onlyLive} onlyLive)`
  );
  console.log(
    `S2: ${totals.S2.agree}/${totals.S2.bars} bars agree (${s2Pct}%), ` +
      `${totals.S2.matched}/${totals.S2.previewTrades} preview trades matched, ` +
      `${totals.S2.liveTrades} live trades (${totals.S2.onlyPreview} onlyPreview, ${totals.S2.onlyLive} onlyLive)`
  );

  if (rest) {
    const syms = Object.keys(rest);
    const totalTimeMis = syms.reduce((sum, s) => sum + rest[s].timeMismatches, 0);
    const totalFieldMis = syms.reduce((sum, s) => sum + rest[s].fieldMismatches, 0);
    console.log(
      `REST: ${syms.length} symbols, ${totalTimeMis} time mismatches, ${totalFieldMis} field mismatches`
    );
  } else {
    console.log('REST: skipped');
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
