/**
 * Pure core of the lab pre-lock preview: hurdle series and real-returns null.
 *
 * Descriptive preview of the typical hurdle b each hypothesis will face before
 * the forward lab is locked, from historical turnover and return dispersion.
 * This is descriptive only and never gates the lock.
 *
 * It also runs the e-process null on real perp returns (random scores, real b)
 * to demonstrate that the false-crossing rate holds on fat-tailed, cross-correlated data.
 *
 * Hard rule: the preview never measures how a candidate's real scores relate to returns.
 * No function here may combine a real score series with returns into X, a correlation,
 * a hit rate or a return. Real scores feed turnover only, and returns feed dispersion
 * and the null only.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { bookWeights, kN, populationSd, rankWeightedCorrelation } from '@/lib/stats/rank-ic';
import { bookTurnover, hurdle, LAB_S_WINDOW, trailingS } from '@/lib/signals/lab/hurdle';
import { initialEState, isValidated, type LabBar, runEProcess } from '@/lib/signals/lab/e-process';
import { LAB_MIN_CROSS_SECTION, LAB_TIMEFRAME_MS, L2_V8_STYLE } from '@/lib/signals/lab/candidates';
import { type HourBar, l2Scores, l3Scores } from '@/lib/signals/lab/factors';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { prepareSteps } from './rv-mcpt';
import { rvComposite, RV_V1 } from '@/lib/signals/cross-sectional/engine';
import type { RvPanel } from './rv-panel';
import { loadManifest, loadPerp, parseJsonlGz } from './load-dataset';
import type { PerpCandleRow } from './dataset-format';

/** Scores known at bar close t (ms). Higher = more long. */
export interface ScoreBar {
  t: number;
  scores: Record<string, number>;
}

/** Per-symbol simple returns of the bar that opens at t, i.e. over [t, t + bar length). */
export interface ReturnBar {
  t: number;
  returns: Record<string, number>;
}

export interface HurdlePoint {
  t: number;
  /** Coins with both a score and a return. */
  n: number;
  turnover: number | null;
  kN: number | null;
  /** Cross-sectional population SD of this bar's returns, null when n < LAB_MIN_CROSS_SECTION. */
  s: number | null;
  /** Trailing mean of the previous LAB_S_WINDOW non-null s values (past bars only). */
  sHat: number | null;
  b: number | null;
}

export interface Summary {
  n: number;
  mean: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

/**
 * Summarises numeric values ignoring null and non-finite entries.
 * Percentiles by linear interpolation on the sorted values (p = q * (n - 1)).
 * With no values every field except n (0) is null.
 */
export function summarise(values: readonly (number | null)[]): Summary {
  const valid: number[] = [];
  for (const v of values) {
    if (v !== null && Number.isFinite(v)) {
      valid.push(v);
    }
  }

  const n = valid.length;
  if (n === 0) {
    return { n: 0, mean: null, p10: null, p50: null, p90: null };
  }

  const sum = valid.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;

  valid.sort((a, b) => a - b);

  const quantile = (q: number): number => {
    const p = q * (n - 1);
    const low = Math.floor(p);
    const high = Math.ceil(p);
    if (low === high) {
      return valid[low];
    }
    const fraction = p - low;
    return valid[low] + fraction * (valid[high] - valid[low]);
  };

  return {
    n,
    mean,
    p10: quantile(0.1),
    p50: quantile(0.5),
    p90: quantile(0.9),
  };
}

/**
 * Builds the historical hurdle series for a hypothesis.
 * Real candidate scores are used only to compute book weights and turnover.
 * Real returns are used only to compute cross-sectional dispersion s.
 */
export function hurdleSeries(
  scoreBars: readonly ScoreBar[],
  returnBars: readonly ReturnBar[]
): HurdlePoint[] {
  const sortedScoreBars = [...scoreBars].sort((a, b) => a.t - b.t);
  const returnMap = new Map<number, Record<string, number>>();
  for (const rb of returnBars) {
    returnMap.set(rb.t, rb.returns);
  }

  let prevWeights: Record<string, number> | null = null;
  const pastS: number[] = [];
  const points: HurdlePoint[] = [];

  for (const scoreBar of sortedScoreBars) {
    const returnObj = returnMap.get(scoreBar.t);
    if (!returnObj) {
      points.push({
        t: scoreBar.t,
        n: 0,
        turnover: null,
        kN: null,
        s: null,
        sHat: null,
        b: null,
      });
      continue;
    }

    const scoredCoins = Object.keys(scoreBar.scores)
      .filter((sym) => Number.isFinite(scoreBar.scores[sym]))
      .sort();

    const coinsWithBoth = scoredCoins.filter((sym) => Number.isFinite(returnObj[sym]));
    const n = coinsWithBoth.length;

    if (n < LAB_MIN_CROSS_SECTION) {
      points.push({
        t: scoreBar.t,
        n,
        turnover: null,
        kN: null,
        s: null,
        sHat: null,
        b: null,
      });
      continue;
    }

    const scoredScores = scoredCoins.map((sym) => scoreBar.scores[sym]);
    const rawWeights = bookWeights(scoredScores);
    const weights: Record<string, number> = {};
    for (let i = 0; i < scoredCoins.length; i++) {
      weights[scoredCoins[i]] = rawWeights[i];
    }

    const turnover = bookTurnover(prevWeights, weights);
    const knVal = kN(scoredScores);

    const bothReturns = coinsWithBoth.map((sym) => returnObj[sym]);
    const s = populationSd(bothReturns);

    const sHat = trailingS(pastS, LAB_S_WINDOW);
    const b = hurdle({ turnover, kN: knVal, sHat });

    points.push({
      t: scoreBar.t,
      n,
      turnover,
      kN: knVal,
      s,
      sHat,
      b,
    });

    pastS.push(s);
    prevWeights = weights;
  }

  return points;
}

/**
 * Calibrates the e-process null on real returns with random scores.
 * Never sees a candidate's real scores.
 */
export function nullCalibration(
  returnBars: readonly ReturnBar[],
  hurdleByT: ReadonlyMap<number, number | null>,
  opts: { runs: number; seed: number }
): { runs: number; bars: number; crossings: number; crossingsB0: number } {
  const sortedReturnBars = [...returnBars].sort((a, b) => a.t - b.t);

  interface PreparedReturnBar {
    t: number;
    symbols: string[];
    returns: number[];
  }

  const eligibleBars: PreparedReturnBar[] = [];
  for (const bar of sortedReturnBars) {
    const symbols = Object.keys(bar.returns)
      .filter((sym) => Number.isFinite(bar.returns[sym]))
      .sort();
    if (symbols.length >= LAB_MIN_CROSS_SECTION) {
      eligibleBars.push({
        t: bar.t,
        symbols,
        returns: symbols.map((sym) => bar.returns[sym]),
      });
    }
  }

  const bars = eligibleBars.length;
  let crossings = 0;
  let crossingsB0 = 0;

  const rand = createSeededRandom(opts.seed);
  const sampleNormal = (): number => {
    let u1 = rand();
    while (u1 <= 0 || u1 >= 1) {
      u1 = rand();
    }
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  for (let run = 0; run < opts.runs; run++) {
    const barsB: LabBar[] = [];
    const barsB0: LabBar[] = [];

    for (const eb of eligibleBars) {
      const scores = eb.symbols.map(() => sampleNormal());
      const x = rankWeightedCorrelation(scores, eb.returns);
      const b = hurdleByT.get(eb.t) ?? null;

      barsB.push({ barTime: eb.t, x, b });
      barsB0.push({ barTime: eb.t, x, b: 0 });
    }

    const stepsB = runEProcess(barsB);
    const finalStateB = stepsB.length > 0 ? stepsB[stepsB.length - 1].state : initialEState();
    if (isValidated(finalStateB)) {
      crossings++;
    }

    const stepsB0 = runEProcess(barsB0);
    const finalStateB0 = stepsB0.length > 0 ? stepsB0[stepsB0.length - 1].state : initialEState();
    if (isValidated(finalStateB0)) {
      crossingsB0++;
    }
  }

  return {
    runs: opts.runs,
    bars,
    crossings,
    crossingsB0,
  };
}

/**
 * Builds L1 score bars from an 8h perp panel.
 */
export function l1ScoreBars(panel: RvPanel): ScoreBar[] {
  const prep = prepareSteps(panel);
  const out: ScoreBar[] = [];
  for (let i = 0; i < prep.rows.length; i++) {
    const t = panel.t[prep.firstStep + i] + RV_V1.barMs;
    const ranked = rvComposite(prep.rows[i], RV_V1.weights);
    const scores: Record<string, number> = {};
    for (const r of ranked) {
      scores[r.symbol] = r.compositeZ;
    }
    out.push({ t, scores });
  }
  return out;
}

/**
 * Finds the latest L1 bar with bar.t <= t and ranks symbols descending by compositeZ (rank 1 = highest).
 * Ties keep the sorted symbol order.
 */
export function l1RanksAt(
  l1Bars: readonly ScoreBar[],
  t: number
): { symbol: string; compositeZ: number; rank: number }[] | null {
  let latest: ScoreBar | null = null;
  for (const bar of l1Bars) {
    if (bar.t <= t) {
      if (latest === null || bar.t > latest.t) {
        latest = bar;
      }
    }
  }

  if (latest === null) {
    return null;
  }

  const items = Object.entries(latest.scores).map(([symbol, compositeZ]) => ({
    symbol,
    compositeZ,
    rank: 0,
  }));

  items.sort((a, b) => b.compositeZ - a.compositeZ || a.symbol.localeCompare(b.symbol));
  items.forEach((item, index) => {
    item.rank = index + 1;
  });

  return items;
}

/**
 * Builds L2 score bars by combining v8 scores and L1 ranks.
 */
export function l2ScoreBars(
  rows: readonly { symbol: string; candleTimestamp: number; score: number }[],
  intervalMs: number,
  symbols: readonly string[],
  l1Bars: readonly ScoreBar[]
): ScoreBar[] {
  const byT = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const t = row.candleTimestamp + intervalMs;
    let v8ByT = byT.get(t);
    if (!v8ByT) {
      v8ByT = {};
      byT.set(t, v8ByT);
    }
    v8ByT[row.symbol] = row.score;
  }

  const sortedTs = Array.from(byT.keys()).sort((a, b) => a - b);
  const out: ScoreBar[] = [];

  for (const t of sortedTs) {
    const ranks = l1RanksAt(l1Bars, t);
    if (ranks === null) {
      continue;
    }
    const v8ByT = byT.get(t)!;
    const { scores } = l2Scores(symbols, v8ByT, ranks);
    out.push({ t, scores });
  }

  return out;
}

function findFirstBarIndex(bars: readonly HourBar[], minOpenTime: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bars[mid].openTime >= minOpenTime) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

/**
 * Builds L3 score bars using a 169-bar rolling window of 1h realized variance.
 */
export function l3ScoreBars(
  barsBySymbol: Readonly<Record<string, readonly HourBar[]>>,
  closes: readonly number[],
  symbols: readonly string[]
): ScoreBar[] {
  const sortedBarsBySymbol = new Map<string, HourBar[]>();
  for (const sym of symbols) {
    const bars = barsBySymbol[sym];
    if (bars && bars.length > 0) {
      sortedBarsBySymbol.set(sym, [...bars].sort((a, b) => a.openTime - b.openTime));
    }
  }

  const sortedCloses = [...closes].sort((a, b) => a - b);
  const out: ScoreBar[] = [];

  for (const T of sortedCloses) {
    const windowed: Record<string, HourBar[]> = {};
    const minOpen = T - 169 * 3_600_000;

    for (const sym of symbols) {
      const bars = sortedBarsBySymbol.get(sym);
      if (!bars) continue;

      const startIndex = findFirstBarIndex(bars, minOpen);
      let endIndex = startIndex;
      while (endIndex < bars.length && bars[endIndex].closeTime < T) {
        endIndex++;
      }
      if (endIndex > startIndex) {
        windowed[sym] = bars.slice(startIndex, endIndex);
      }
    }

    const { scores } = l3Scores(symbols, windowed, T);
    out.push({ t: T, scores });
  }

  return out;
}

/**
 * Derives ReturnBars from an RvPanel.
 */
export function returnBarsFromPanel(panel: RvPanel): ReturnBar[] {
  const out: ReturnBar[] = [];
  const numBars = panel.t.length;
  const numSymbols = panel.symbols.length;

  for (let k = 0; k < numBars; k++) {
    const t = panel.t[k];
    const returns: Record<string, number> = {};

    for (let s = 0; s < numSymbols; s++) {
      const sym = panel.symbols[s];
      const o = panel.open[s][k];
      const c = panel.close[s][k];
      if (Number.isFinite(o) && o > 0 && Number.isFinite(c)) {
        returns[sym] = c / o - 1;
      }
    }

    out.push({ t, returns });
  }

  return out;
}

/**
 * Derives ReturnBars from per-symbol candle rows.
 */
export function returnBarsFromRows(
  rowsBySymbol: Readonly<Record<string, readonly { t: number; o: number; c: number }[]>>
): ReturnBar[] {
  const byT = new Map<number, Record<string, number>>();

  for (const [sym, rows] of Object.entries(rowsBySymbol)) {
    for (const row of rows) {
      let returns = byT.get(row.t);
      if (!returns) {
        returns = {};
        byT.set(row.t, returns);
      }
      if (Number.isFinite(row.o) && row.o > 0 && Number.isFinite(row.c)) {
        returns[sym] = row.c / row.o - 1;
      }
    }
  }

  const sortedTs = Array.from(byT.keys()).sort((a, b) => a - b);
  const out: ReturnBar[] = [];

  for (const t of sortedTs) {
    out.push({ t, returns: byT.get(t)! });
  }

  return out;
}

export interface PreviewArgs {
  panel: string;
  rescoreRows: string;
  rescoreDs: string;
  rvDs: string;
  out: string;
  runs: number; // default 1000
  seed: number; // default 20261018
}

export function parseArgs(argv: string[]): PreviewArgs {
  let panel: string | null = null;
  let rescoreRows: string | null = null;
  let rescoreDs: string | null = null;
  let rvDs: string | null = null;
  let out: string | null = null;
  let runs = 1000;
  let seed = 20261018;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return v;
    };

    if (flag === '--panel') {
      panel = value();
    } else if (flag === '--rescore-rows') {
      rescoreRows = value();
    } else if (flag === '--rescore-ds') {
      rescoreDs = value();
    } else if (flag === '--rv-ds') {
      rvDs = value();
    } else if (flag === '--out') {
      out = value();
    } else if (flag === '--runs') {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0 || !/^\d+$/.test(raw)) {
        throw new Error(`${flag} must be a positive integer`);
      }
      runs = n;
    } else if (flag === '--seed') {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0 || !/^\d+$/.test(raw)) {
        throw new Error(`${flag} must be a positive integer`);
      }
      seed = n;
    } else {
      throw new Error(`Unknown flag "${flag}"`);
    }
  }

  if (!panel) throw new Error('--panel is required');
  if (!rescoreRows) throw new Error('--rescore-rows is required');
  if (!rescoreDs) throw new Error('--rescore-ds is required');
  if (!rvDs) throw new Error('--rv-ds is required');
  if (!out) throw new Error('--out is required');

  return { panel, rescoreRows, rescoreDs, rvDs, out, runs, seed };
}

export interface HypothesisPreview {
  bars: number; // HurdlePoints with n >= LAB_MIN_CROSS_SECTION
  from: string | null; // ISO time of the first such point
  to: string | null; // ISO time of the last such point
  turnover: Summary;
  s: Summary;
  b: Summary;
}

export interface PreviewReport {
  kind: 'lab-preview';
  version: 'lab-v1';
  generatedAt: string;
  provenance: Record<string, string>;
  hypotheses: Record<string, HypothesisPreview | { previewed: false; reason: string }>;
  nullCalibration: Record<string, { runs: number; bars: number; crossings: number; crossingsB0: number }>;
}

export interface PreviewInputs {
  l1Bars: ScoreBar[];
  panelReturns: ReturnBar[];
  l3Bars: ScoreBar[];
  /** Keyed by L2 timeframe: '5m' | '15m' | '1h' | '4h' | '1d'. */
  l2: Record<string, { scoreBars: ScoreBar[]; returnBars: ReturnBar[] }>;
}

function hurdlePointsToPreview(points: readonly HurdlePoint[]): HypothesisPreview {
  const eligible = points.filter((p) => p.n >= LAB_MIN_CROSS_SECTION);
  return {
    bars: eligible.length,
    from: eligible.length > 0 ? new Date(eligible[0].t).toISOString() : null,
    to: eligible.length > 0 ? new Date(eligible[eligible.length - 1].t).toISOString() : null,
    turnover: summarise(eligible.map((p) => p.turnover)),
    s: summarise(eligible.map((p) => p.s)),
    b: summarise(eligible.map((p) => p.b)),
  };
}

export function buildReport(
  inputs: PreviewInputs,
  opts: {
    runs: number;
    seed: number;
    provenance: Record<string, string>;
    now: Date;
  }
): PreviewReport {
  const hypotheses: Record<string, HypothesisPreview | { previewed: false; reason: string }> = {};

  const l1Points = hurdleSeries(inputs.l1Bars, inputs.panelReturns);
  hypotheses['L1-8h'] = hurdlePointsToPreview(l1Points);

  const l2Tfs = ['5m', '15m', '1h', '4h', '1d'] as const;
  for (const tf of l2Tfs) {
    const l2Entry = inputs.l2[tf];
    if (l2Entry) {
      const l2Points = hurdleSeries(l2Entry.scoreBars, l2Entry.returnBars);
      hypotheses[`L2-${tf}`] = hurdlePointsToPreview(l2Points);
    }
  }

  const l3Points = hurdleSeries(inputs.l3Bars, inputs.panelReturns);
  hypotheses['L3-8h'] = hurdlePointsToPreview(l3Points);

  hypotheses['L4-8h'] = {
    previewed: false,
    reason: 'No stored 4h top-trader position ratio history. Binance REST serves only the last 30 days.',
  };

  const l1HurdleMap = new Map<number, number | null>();
  for (const p of l1Points) {
    l1HurdleMap.set(p.t, p.b);
  }
  const l1Null = nullCalibration(inputs.panelReturns, l1HurdleMap, {
    runs: opts.runs,
    seed: opts.seed,
  });

  const l3HurdleMap = new Map<number, number | null>();
  for (const p of l3Points) {
    l3HurdleMap.set(p.t, p.b);
  }
  const l3Null = nullCalibration(inputs.panelReturns, l3HurdleMap, {
    runs: opts.runs,
    seed: opts.seed + 1,
  });

  return {
    kind: 'lab-preview',
    version: 'lab-v1',
    generatedAt: opts.now.toISOString(),
    provenance: opts.provenance,
    hypotheses,
    nullCalibration: {
      'L1-8h': l1Null,
      'L3-8h': l3Null,
    },
  };
}

export async function main(argv?: string[]): Promise<number> {
  const args = parseArgs(argv ?? process.argv.slice(2));

  const panelBytes = readFileSync(args.panel);
  const panelSha256 = createHash('sha256').update(panelBytes).digest('hex');
  const parsedPanelJson = JSON.parse(gunzipSync(panelBytes).toString('utf8')) as { panel: RvPanel };
  const panel = parsedPanelJson.panel;

  const rowsBytes = readFileSync(args.rescoreRows);
  const rescoreRowsSha256 = createHash('sha256').update(rowsBytes).digest('hex');
  const rawRows = parseJsonlGz<Record<string, unknown>>(rowsBytes);

  const rows: {
    symbol: string;
    interval: string;
    tradingStyle: string;
    score: number;
    candleTimestamp: number;
    configVersion: number;
  }[] = [];

  for (const r of rawRows) {
    const configVersion = r.configVersion;
    if (configVersion !== 8) {
      throw new Error(`rescore row with configVersion ${configVersion}, expected 8`);
    }
    rows.push({
      symbol: String(r.symbol),
      interval: String(r.interval),
      tradingStyle: String(r.tradingStyle),
      score: Number(r.score),
      candleTimestamp: Number(r.candleTimestamp),
      configVersion: 8,
    });
  }

  const symbols = SIGNAL_SYMBOLS;
  const l1Bars = l1ScoreBars(panel);
  const panelReturns = returnBarsFromPanel(panel);

  const barsBySymbol: Record<string, HourBar[]> = {};
  for (const sym of symbols) {
    const loaded = loadPerp(args.rvDs, sym, '1h', 'klines', { allowLockbox: true });
    barsBySymbol[sym] = loaded.rows.map((r) => ({
      openTime: r.t,
      closeTime: r.t + 3_600_000 - 1,
      close: r.c,
    }));
  }
  const l3Bars = l3ScoreBars(barsBySymbol, l1Bars.map((b) => b.t), symbols);

  const l2: Record<string, { scoreBars: ScoreBar[]; returnBars: ReturnBar[] }> = {};
  for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
    const tfRows = rows.filter(
      (r) => r.interval === tf && r.tradingStyle === L2_V8_STYLE[tf]
    );
    const intervalMs = LAB_TIMEFRAME_MS[tf];
    const scoreBars = l2ScoreBars(tfRows, intervalMs, symbols, l1Bars);

    const rowsBySymbolPerp: Record<string, PerpCandleRow[]> = {};
    for (const sym of symbols) {
      rowsBySymbolPerp[sym] = loadPerp(args.rescoreDs, sym, tf, 'klines', { allowLockbox: true }).rows;
    }
    const returnBars = returnBarsFromRows(rowsBySymbolPerp);
    l2[tf] = { scoreBars, returnBars };
  }

  const provenance: Record<string, string> = {
    panelSha256,
    rescoreRowsSha256,
    rescoreDsHash: loadManifest(args.rescoreDs).datasetHash,
    rvDsHash: loadManifest(args.rvDs).datasetHash,
  };

  const report = buildReport(
    { l1Bars, panelReturns, l3Bars, l2 },
    { runs: args.runs, seed: args.seed, provenance, now: new Date() }
  );

  writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n', 'utf8');

  for (const [id, hyp] of Object.entries(report.hypotheses)) {
    if ('previewed' in hyp && !hyp.previewed) {
      console.log(`${id} bars 0 b p50 n/a`);
    } else {
      const p = hyp as HypothesisPreview;
      console.log(`${id} bars ${p.bars} b p50 ${p.b.p50}`);
    }
  }

  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
