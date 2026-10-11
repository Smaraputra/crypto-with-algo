import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StrategyReport } from './report-schema';
import {
  DIRECTION_EXIT_CONFIRM, DIRECTION_EXIT_DEVELOP, DIRECTION_EXIT_EXPORT, DIRECTION_EXIT_SYMBOLS,
  type DirectionExitFit, type DirectionExitSelection,
} from './direction-exit';
import {
  anatolyevGerko,
  buildSelect,
  checkFit,
  commitOf,
  condFor,
  confirmJobs,
  developAJobs,
  developBJobs,
  directoryProblems,
  jobLine,
  jobsFor,
  judgeConfiguration,
  loadReports,
  mfeCaptureNet,
  namedReport,
  neweyWestT,
  pickBest,
  provenanceProblems,
  REPORT_NAME_PATTERN,
  selectFor,
  tradesOf,
  type DxTrade,
  type NamedReport,
} from './direction-exit-judge';

const DAY = 86_400_000;
const t2025 = Date.UTC(2025, 2, 1);
const t2026 = Date.UTC(2026, 2, 1);
const GATES = ['sample', 'expectancy', 'windows', 'symbols', 'timing', 'trials', 'plateau', 'stress'];

/** A report carrying only the fields the judge reads, under their StrategyReport names. */
function report(pnls: Array<[number, number]>, over: Record<string, unknown> = {}): StrategyReport {
  const trades = pnls.map(([exitTime, p], i) => ({
    entryTime: exitTime - DAY, exitTime, side: i % 2 ? 'short' : 'long', pnlPercent: p, exitReason: 'time_stop', holdTimeBars: 23,
  }));
  return {
    family: 'dx-d0',
    interval: '1h',
    symbols: [...DIRECTION_EXIT_SYMBOLS],
    datasetManifestHash: 'h',
    gitCommit: 'c1',
    dateRange: { startMs: Date.parse(DIRECTION_EXIT_EXPORT.start), endMs: Date.parse(DIRECTION_EXIT_CONFIRM.end) },
    windowConfig: { mode: 'anchored', trainFraction: 0.4, count: 6, minIsTrades: 10 },
    benchmark: { enabled: true, iterations: 100, seed: 1 },
    fixedParams: { exit: 1, k: 1 },
    fixedEvaluation: { evalFrom: Date.parse(DIRECTION_EXIT_CONFIRM.start), fundingSource: 'settlements', price: 'spot' },
    pooled: { n: trades.length },
    perSymbol: [{ symbol: 'BTCUSDT', windows: [{ trades }] }],
    gates: GATES.map((name) => ({ name, pass: true, value: null, threshold: 0 })),
    ...over,
  } as unknown as StrategyReport;
}

const developWindow = {
  dateRange: { startMs: Date.parse(DIRECTION_EXIT_EXPORT.start), endMs: Date.parse(DIRECTION_EXIT_DEVELOP.end) },
  fixedEvaluation: { evalFrom: Date.parse(DIRECTION_EXIT_DEVELOP.start), fundingSource: 'settlements', price: 'spot' },
  benchmark: { enabled: false, iterations: 100, seed: 1 },
};

describe('tradesOf', () => {
  it('flattens per-symbol windows in exit order with the symbol attached', () => {
    const r = report([[t2026, 1], [t2025, -1]]);
    expect(tradesOf(r).map((t) => [t.symbol, t.exitTime])).toEqual([['BTCUSDT', t2025], ['BTCUSDT', t2026]]);
  });

  it('requires the trades of every window and a total equal to pooled.n', () => {
    const r = report([[t2025, 1]]);
    const noTrades = { ...r, perSymbol: [{ symbol: 'BTCUSDT', windows: [{ trades: r.perSymbol[0].windows[0].trades }, {}] }] };
    expect(() => tradesOf(noTrades as unknown as StrategyReport)).toThrow(/window 1 has no trades/);
    expect(() => tradesOf({ ...r, pooled: { n: 2 } } as unknown as StrategyReport)).toThrow(/pooled.n 2/);
  });
});

describe('pickBest', () => {
  it('takes the highest expectancy that clears the trade and coverage floors, a tie to coverage then order', () => {
    const runs = [
      { key: 'C1', expectancy: 0.5, trades: 5, coverage: 0.5 },
      { key: 'C2', expectancy: 0.2, trades: 400, coverage: 0.2 },
      { key: 'C3', expectancy: 0.1, trades: 400, coverage: 0.6 },
      { key: 'C4', expectancy: 0.1, trades: 400, coverage: 0.7 },
    ];
    expect(pickBest(runs, { minTrades: 10, minCoverage: 0.3 })).toBe('C4');
    expect(pickBest(runs, { minTrades: 0, minCoverage: 0.3 })).toBe('C1');
    expect(pickBest([{ key: 'a', expectancy: 1, trades: 10 }, { key: 'b', expectancy: 1, trades: 10 }], { minTrades: 10 })).toBe('a');
    expect(() => pickBest([{ key: 'x', expectancy: 1, trades: 9 }], { minTrades: 10 })).toThrow();
    expect(() => pickBest([{ key: 'x', expectancy: null, trades: 0 }], { minTrades: 0 })).toThrow();
  });
});

describe('judgeConfiguration', () => {
  it('fails a configuration whose 2026 part has no trades, never passing on NaN', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [t2025 + i * 3_600_000, 0.5]);
    const v = judgeConfiguration({ config: 'dx-d0 1h E1', report: report(pnls), varianceOfTrialSharpes: 0.01, numTrials: 2135 });
    expect(v.pass).toBe(false);
    expect(v.failed).toContain('part:2026');
  });

  it('carries a failed harness gate but ignores the inert trials and plateau gates', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [(i % 2 ? t2025 : t2026) + i * 3_600_000, 0.5]);
    const gates = GATES.map((name) => ({ name, pass: !['symbols', 'trials', 'plateau'].includes(name), value: null, threshold: 0 }));
    const v = judgeConfiguration({ config: 'x', report: report(pnls, { gates }), varianceOfTrialSharpes: 0.0001, numTrials: 2135 });
    expect(v.failed).toContain('symbols');
    expect(v.failed).not.toContain('trials');
    expect(v.failed).not.toContain('plateau');
  });

  it('fails a missing harness gate by name instead of passing it vacuously', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [(i % 2 ? t2025 : t2026) + i * 3_600_000, 0.5]);
    const gates = GATES.filter((g) => g !== 'timing').map((name) => ({ name, pass: true, value: null, threshold: 0 }));
    const v = judgeConfiguration({ config: 'x', report: report(pnls, { gates }), varianceOfTrialSharpes: 0.0001, numTrials: 2135 });
    expect(v.failed).toContain('gate-missing:timing');
    expect(v.pass).toBe(false);
    const none = judgeConfiguration({ config: 'x', report: report(pnls, { gates: [] }), varianceOfTrialSharpes: 0.0001, numTrials: 2135 });
    expect(none.failed.filter((f) => f.startsWith('gate-missing:'))).toHaveLength(6);
  });

  it('fails the Bonferroni gate when the interval reaches zero', () => {
    const pnls: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [(i % 2 ? t2025 : t2026) + i * 3_600_000, i % 2 ? 1 : -0.9]);
    expect(judgeConfiguration({ config: 'x', report: report(pnls), varianceOfTrialSharpes: 0.01, numTrials: 2135 }).failed).toContain('bonferroni');
  });

  it('fills the reported statistics without letting them gate', () => {
    // Trades alternate long, short: pnl -1 (long), 2 (short), 2 (long), -1 (short), ...
    const pnls: Array<[number, number]> = Array.from({ length: 10 }, (_, i) => [t2025 + i * 3_600_000, i % 3 === 0 ? -1 : 2]);
    const v = judgeConfiguration({ config: 'x', report: report(pnls), varianceOfTrialSharpes: 0.01, numTrials: 2135, exit: 1 });
    expect(v.reported.winRate).toBeCloseTo(0.6, 10);
    expect(v.reported.avgWin).toBe(2);
    expect(v.reported.avgLoss).toBe(-1);
    expect(v.reported.payoff).toBe(2);
    // Longs (i = 0, 2, 4, 6, 8): wins at 2, 4, 8 = 3/5; shorts (i = 1, 3, 5, 7, 9): wins at 1, 5, 7 = 3/5.
    expect(v.reported.balancedHitRate).toBeCloseTo(0.6, 10);
    expect(v.reported['exitReason:time_stop']).toBe(10);
    expect(v.reported.protectiveStops).toBe(0);
    expect(v.reported.mfeCaptureNet).toBeNull();
    expect(v.reported).not.toHaveProperty('mfeCapture');
    expect(v.reported.agStat).not.toBeNull();
  });
});

describe('neweyWestT', () => {
  const x = [0, 0, 1, 1];
  const y = [0, 1, 1, 1];
  it('matches the hand-computed lag 0 t (sqrt 2)', () => {
    expect(neweyWestT(x, y, 0)).toBeCloseTo(Math.SQRT2, 10);
  });
  it('applies the Bartlett weight at lag 1 (t = 2)', () => {
    expect(neweyWestT(x, y, 1)).toBeCloseTo(2, 10);
  });
  it('is null for a constant regressor', () => {
    expect(neweyWestT([1, 1, 1, 1], y, 1)).toBeNull();
  });
});

describe('anatolyevGerko', () => {
  it('is the excess-profitability statistic EP of Ruling R12 on a hand-computed input', () => {
    // f = (1, -1, 1), r = (2, -1, -1): A = 2/3, B = (1/3)(0) = 0, p = 2/3, V = 4/9 * 2/9 * 6 = 16/27, EP = sqrt(3)/2.
    expect(anatolyevGerko([1, -1, 1], [2, -1, -1])).toBeCloseTo(Math.sqrt(3) / 2, 12);
  });
  it('is null with one call direction only, too few calls, or mismatched inputs', () => {
    expect(anatolyevGerko([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(anatolyevGerko([1], [1])).toBeNull();
    expect(anatolyevGerko([1, -1], [1])).toBeNull();
  });
});

describe('mfeCaptureNet', () => {
  const candles = {
    BTCUSDT: [
      { t: 0, o: 100, h: 104, l: 99, c: 102, v: 1, tbv: null },
      { t: 1, o: 102, h: 110, l: 101, c: 105, v: 1, tbv: null },
      { t: 2, o: 106, h: 120, l: 90, c: 100, v: 1, tbv: null },
    ],
  };
  const trade: DxTrade = { symbol: 'BTCUSDT', entryTime: 0, exitTime: 1, side: 'long', pnlPercent: 4, exitReason: 'time_stop' };

  it('divides the realised net return by the best excursion from the entry open, direction-signed', () => {
    expect(mfeCaptureNet([trade], candles)).toBeCloseTo(0.04 / 0.1, 10);
    // short MFE = (100 - 99) / 100 = 1%; the net return -5% gives -5.
    expect(mfeCaptureNet([{ ...trade, side: 'short', pnlPercent: -5 }], candles)).toBeCloseTo(-5, 10);
  });

  it('stops a next-open exit at the exit bar open, never reading that bar range', () => {
    // A 'signal' exit at t = 2 fills at its open 106: MFE 10% from bar 1's high, not 20% from bar 2's.
    expect(mfeCaptureNet([{ ...trade, exitTime: 2, exitReason: 'signal' }], candles)).toBeCloseTo(0.04 / 0.1, 10);
  });

  it('skips trades without candles or without a favourable excursion', () => {
    expect(mfeCaptureNet([{ ...trade, symbol: 'ETHUSDT' }], candles)).toBeNull();
    expect(mfeCaptureNet([{ ...trade, side: 'short', entryTime: 0, exitTime: 0 }], { BTCUSDT: [{ ...candles.BTCUSDT[0], l: 100 }] })).toBeNull();
  });
});

function named(family: string, interval: '1h' | '4h', cond: number, exit: number, k: number, n: number, pnl: number, commit = 'c1'): NamedReport {
  const name = `${family}-${interval}-c${cond}-e${exit}-k${k}`;
  const trades = Array.from({ length: n }, (_, i): DxTrade => ({
    symbol: 'BTCUSDT', entryTime: i, exitTime: i + 1, side: 'long', pnlPercent: pnl, exitReason: 'time_stop',
  }));
  return { file: `${name}.json`, name, family, interval, cond, exit, k, report: { gitCommit: commit, datasetManifestHash: 'h' } as unknown as StrategyReport, trades };
}

describe('condFor', () => {
  it('applies only the coverage floor against the D0 E1 trade count, per interval (no trade floor)', () => {
    const reports = [
      named('dx-d0', '1h', 0, 1, 1, 500, 0),
      named('dx-d2', '1h', 1, 1, 1, 90, 1.0), // coverage 0.18 < 0.3
      named('dx-d2', '1h', 2, 1, 1, 120, 0.9), // coverage 0.24 < 0.3
      named('dx-d2', '1h', 3, 1, 1, 150, 0.4), // coverage 0.30, qualifies
      named('dx-d2', '1h', 4, 1, 1, 300, 0.1),
      named('dx-d0', '4h', 0, 1, 1, 20, 0),
      named('dx-d2', '4h', 1, 1, 1, 7, 0.2), // coverage 0.35 on 7 trades: no trade floor, so it qualifies
      named('dx-d2', '4h', 2, 1, 1, 15, 0.1),
      named('dx-d2', '4h', 3, 1, 1, 12, -0.1),
      named('dx-d2', '4h', 4, 1, 1, 11, 0.15),
    ];
    expect(condFor(reports, '1h')).toBe(3);
    expect(condFor(reports, '4h')).toBe(1);
  });

  it('throws without a D0 E1 report', () => {
    expect(() => condFor([named('dx-d2', '1h', 1, 1, 1, 200, 1)], '1h')).toThrow();
  });
});

describe('selectFor', () => {
  const base = [
    named('dx-d0', '1h', 0, 1, 1, 100, 0),
    named('dx-d2', '1h', 1, 1, 1, 60, 0.3),
    named('dx-d2', '1h', 3, 1, 1, 50, 0.5), // the chosen condition
    named('dx-d2', '1h', 2, 1, 1, 10, 0.1),
    named('dx-d2', '1h', 4, 1, 1, 10, 0.1),
  ];
  const kRuns = (family: string, cond: number, exit: number, spec: Array<[number, number, number]>) =>
    spec.map(([k, n, pnl]) => named(family, '1h', cond, exit, k, n, pnl));

  it('picks k by develop expectancy over the harness minimum trade count, earliest k on a tie, D2 under its condition', () => {
    const reports = [
      ...base,
      ...kRuns('dx-d0', 0, 2, [[1, 50, 0.1], [1.5, 9, 0.9], [2, 50, 0.3]]), // k 1.5 has 9 < 10 trades
      ...kRuns('dx-d0', 0, 3, [[1, 50, 0.2], [1.5, 50, 0.1], [2, 50, 0.2]]), // tie between k 1 and k 2
      ...kRuns('dx-d1', 0, 2, [[1, 50, 0.1], [1.5, 50, 0.2], [2, 50, 0.15]]),
      ...kRuns('dx-d1', 0, 3, [[1, 50, 0.3], [1.5, 50, 0.2], [2, 50, 0.1]]),
      ...kRuns('dx-d2', 3, 2, [[1, 50, 0.1], [1.5, 50, 0.05], [2, 50, 0.2]]),
      ...kRuns('dx-d2', 3, 3, [[1, 50, 0.1], [1.5, 50, 0.3], [2, 50, 0.2]]),
      ...kRuns('dx-d2', 1, 2, [[1, 50, 9], [1.5, 50, 9], [2, 50, 9]]), // another condition: never read
    ];
    expect(selectFor(reports, '1h')).toEqual({ d2Condition: 3, e2K: { d0: 2, d1: 1.5, d2: 2 }, e3K: { d0: 1, d1: 1, d2: 1.5 } });
  });
});

describe('jobs', () => {
  const pattern = new RegExp(REPORT_NAME_PATTERN);

  it('builds the 40 develop-a jobs with c0 for D0 and D1, the four conditions at E1 for D2, k1 at E1 and E4', () => {
    const jobs = developAJobs();
    expect(jobs).toHaveLength(40);
    expect(new Set(jobs.map((j) => j.name)).size).toBe(40);
    expect(jobs.every((j) => pattern.test(j.name))).toBe(true);
    expect(jobs.filter((j) => j.family === 'dx-d2').map((j) => `${j.interval}c${j.cond}e${j.exit}k${j.k}`)).toEqual(
      ['1h', '4h'].flatMap((iv) => [1, 2, 3, 4].map((c) => `${iv}c${c}e1k1`))
    );
    expect(jobs.filter((j) => j.family !== 'dx-d2').every((j) => j.cond === 0)).toBe(true);
    expect(jobs.filter((j) => j.exit === 1 || j.exit === 4).every((j) => j.k === 1)).toBe(true);
  });

  it('builds the 14 develop-b jobs under each interval condition and prints the job line contract', () => {
    const jobs = developBJobs({ '1h': 3, '4h': 2 });
    expect(jobs).toHaveLength(14);
    expect(jobs.every((j) => j.family === 'dx-d2' && j.cond === (j.interval === '1h' ? 3 : 2) && j.exit >= 2)).toBe(true);
    expect(jobLine(jobs[1])).toBe('dx-d2-1h-c3-e2-k1.5 dx-d2 1h cond=3,exit=2,k=1.5');
    expect(new Set([...developAJobs(), ...jobs].map((j) => j.name)).size).toBe(54);
  });

  const selection: Record<'1h' | '4h', DirectionExitSelection> = {
    '1h': { d2Condition: 3, e2K: { d0: 2, d1: 1.5, d2: 1 }, e3K: { d0: 1, d1: 2, d2: 1.5 } },
    '4h': { d2Condition: 2, e2K: { d0: 1, d1: 1, d2: 2 }, e3K: { d0: 1.5, d1: 1.5, d2: 2 } },
  };

  it('builds the 24 confirm jobs from the selection', () => {
    const jobs = confirmJobs(selection);
    expect(jobs).toHaveLength(24);
    expect(jobs.map(jobLine)).toContain('dx-d0-1h-c0-e2-k2 dx-d0 1h exit=2,k=2');
    expect(jobs.map(jobLine)).toContain('dx-d2-4h-c2-e3-k2 dx-d2 4h cond=2,exit=3,k=2');
    expect(jobs.map(jobLine)).toContain('dx-d1-1h-c0-e4-k1 dx-d1 1h exit=4,k=1');
  });

  it('generates develop-b and confirm jobs only from committed constants that match the judge outputs', () => {
    const conds = { '1h': 3, '4h': 2 } as const;
    expect(() => jobsFor('develop-b', {}, { conds: { '1h': 3, '4h': null }, selection: { '1h': null, '4h': null } })).toThrow(/not committed/);
    expect(jobsFor('develop-b', { condFile: { '1h': 3, '4h': 2, gitCommit: 'a' } }, { conds, selection: { '1h': null, '4h': null } })).toHaveLength(14);
    expect(() => jobsFor('develop-b', { condFile: { '1h': 3, '4h': 1 } }, { conds, selection: { '1h': null, '4h': null } })).toThrow(/4h/);
    expect(() => jobsFor('confirm', {}, { conds, selection: { '1h': selection['1h'], '4h': null } })).toThrow(/not committed/);
    expect(jobsFor('confirm', { selectFile: { selection } }, { conds, selection })).toHaveLength(24);
    const other = { ...selection, '4h': { ...selection['4h'], e3K: { ...selection['4h'].e3K, d0: 2 } } };
    expect(() => jobsFor('confirm', { selectFile: { selection: other } }, { conds, selection })).toThrow(/4h/);
    expect(() => jobsFor('confirm', {}, { conds: { '1h': 3, '4h': 4 }, selection })).toThrow(/d2Condition/);
  });
});

describe('checkFit', () => {
  const fit: DirectionExitFit = {
    signs: { trend: 1, momentum: -1, volume: 1, volatility: 1, futures: -1, sentiment: 1, htf: 1 },
    threshold: 12.5,
    volTopThreshold: { BTCUSDT: 0.01, DOTUSDT: null },
  };
  const diagnosis = (f1h: DirectionExitFit, hash = 'h') => ({
    datasetHash: hash,
    reports: [
      { interval: '1h', lag: 0, fit: { ...f1h, threshold: 99 } },
      { interval: '1h', lag: 1, fit: f1h },
      { interval: '4h', lag: 1, fit },
    ],
  });

  it('passes the committed fit equal to the lag-1 fit and names every difference', () => {
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis(fit), 'h')).toEqual([]);
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis({ ...fit, threshold: 12.5 + 5e-10 }), 'h')).toEqual([]);
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis({ ...fit, threshold: 12.5 + 2e-9 }), 'h').join()).toMatch(/1h threshold/);
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis({ ...fit, signs: { ...fit.signs, htf: -1 } }), 'h').join()).toMatch(/1h sign htf/);
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis({ ...fit, volTopThreshold: { BTCUSDT: 0.01 + 1e-11, DOTUSDT: null } }), 'h').join()).toMatch(/BTCUSDT/);
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis({ ...fit, volTopThreshold: { BTCUSDT: 0.01, DOTUSDT: 0.02 } }), 'h').join()).toMatch(/DOTUSDT/);
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis({ ...fit, volTopThreshold: { BTCUSDT: 0.01 } }), 'h').join()).toMatch(/DOTUSDT/);
    expect(checkFit({ '1h': null, '4h': fit }, diagnosis(fit), 'h').join()).toMatch(/1h.*not committed/);
    expect(checkFit({ '1h': fit, '4h': fit }, diagnosis(fit, 'other'), 'h').join()).toMatch(/datasetHash/);
  });
});

describe('provenanceProblems', () => {
  const dev = (over: Record<string, unknown> = {}) => namedReport('dx-d0-1h-c0-e2-k1.5', report([[t2025, 1]], { ...developWindow, fixedParams: { exit: 2, k: 1.5 }, ...over }));

  it('accepts a develop report run over DEVELOP as its name says', () => {
    expect(provenanceProblems(dev(), 'develop', 'h')).toEqual([]);
  });

  it('names a wrong window, benchmark, window count, dataset, symbols or funding source', () => {
    const p = (over: Record<string, unknown>) => provenanceProblems(dev(over), 'develop', 'h').join(' | ');
    expect(p({ fixedEvaluation: { ...developWindow.fixedEvaluation, evalFrom: Date.parse(DIRECTION_EXIT_CONFIRM.start) } })).toMatch(/evalFrom/);
    expect(p({ dateRange: { ...developWindow.dateRange, endMs: Date.parse(DIRECTION_EXIT_CONFIRM.end) } })).toMatch(/endMs/);
    expect(p({ dateRange: { ...developWindow.dateRange, startMs: Date.parse(DIRECTION_EXIT_DEVELOP.start) } })).toMatch(/startMs/);
    expect(p({ benchmark: { enabled: true } })).toMatch(/benchmark/);
    expect(p({ windowConfig: { count: 5 } })).toMatch(/windows/);
    expect(p({ datasetManifestHash: 'other' })).toMatch(/datasetManifestHash/);
    expect(p({ symbols: ['BTCUSDT'] })).toMatch(/symbols/);
    expect(p({ fixedEvaluation: { ...developWindow.fixedEvaluation, fundingSource: 'snapshots' } })).toMatch(/fundingSource/);
    expect(p({ fixedEvaluation: undefined })).toMatch(/fixed-eval/);
  });

  it('names a report whose family, interval or parameters differ from its filename', () => {
    const p = (over: Record<string, unknown>) => provenanceProblems(dev(over), 'develop', 'h').join(' | ');
    expect(p({ family: 'dx-d1' })).toMatch(/family/);
    expect(p({ interval: '4h' })).toMatch(/interval/);
    expect(p({ fixedParams: { exit: 2, k: 1 } })).toMatch(/fixedParams/);
    expect(p({ fixedParams: { cond: 1, exit: 2, k: 1.5 } })).toMatch(/fixedParams/);
    expect(p({ fixedParams: undefined })).toMatch(/fixedParams/);
    const d2 = namedReport('dx-d2-4h-c3-e1-k1', report([[t2025, 1]], { ...developWindow, family: 'dx-d2', interval: '4h', fixedParams: { cond: 3, exit: 1, k: 1 } }));
    expect(provenanceProblems(d2, 'develop', 'h')).toEqual([]);
  });

  it('requires the CONFIRM window and the benchmark on a confirm report', () => {
    const conf = namedReport('dx-d0-1h-c0-e1-k1', report([[t2025, 1]]));
    expect(provenanceProblems(conf, 'confirm', 'h')).toEqual([]);
    expect(provenanceProblems(conf, 'develop', 'h').join()).toMatch(/evalFrom/);
    const off = namedReport('dx-d0-1h-c0-e1-k1', report([[t2025, 1]], { benchmark: { enabled: false } }));
    expect(provenanceProblems(off, 'confirm', 'h').join()).toMatch(/benchmark/);
  });
});

describe('commitOf', () => {
  it('returns the one commit of a group and throws on two commits or an unknown one', () => {
    expect(commitOf([named('dx-d0', '1h', 0, 1, 1, 1, 0, 'abc'), named('dx-d1', '1h', 0, 1, 1, 1, 0, 'abc')], 'g')).toBe('abc');
    expect(() => commitOf([named('dx-d0', '1h', 0, 1, 1, 1, 0, 'abc'), named('dx-d1', '1h', 0, 1, 1, 1, 0, 'def')], 'g')).toThrow(/abc.*def|def.*abc/);
    expect(() => commitOf([named('dx-d0', '1h', 0, 1, 1, 1, 0, 'unknown')], 'g')).toThrow(/unknown/);
  });
});

describe('buildSelect', () => {
  const conds = { '1h': 3, '4h': 2 } as const;
  const all = (commitB = 'b') => [
    ...developAJobs().map((j) => named(j.family, j.interval, j.cond, j.exit, j.k, 50, j.family === 'dx-d2' && j.cond === conds[j.interval] ? 0.5 : 0.1, 'a')),
    ...developBJobs(conds).map((j) => named(j.family, j.interval, j.cond, j.exit, j.k, 50, 0.2, commitB)),
  ];

  it('records the selection, the trial variance, the dataset and the commit of each develop stage', () => {
    const s = buildSelect(all(), conds);
    expect(s.reports).toBe(54);
    expect(s.gitCommit).toEqual({ developA: 'a', developB: 'b' });
    expect(s.datasetManifestHash).toBe('h');
    expect(s.selection['1h'].d2Condition).toBe(3);
    expect(s.selection['4h'].d2Condition).toBe(2);
    expect(Number.isFinite(s.varianceOfTrialSharpes)).toBe(true);
  });

  it('throws when the develop-b reports mix commits or the picked condition is not the committed one', () => {
    const mixed = all();
    mixed[45] = { ...mixed[45], report: { ...mixed[45].report, gitCommit: 'z' } };
    expect(() => buildSelect(mixed, conds)).toThrow(/develop-b/);
    expect(() => buildSelect(all(), { '1h': 3, '4h': 4 })).toThrow(/4h/);
  });
});

describe('report files', () => {
  it('lists missing files and stray dx files, allowing only the named strays', () => {
    const files = ['dx-d0-1h-c0-e1-k1.json', 'dx-d9-1h-c0-e1-k1.json', 'verdict.json', 'notes.txt'];
    expect(directoryProblems(files, ['dx-d0-1h-c0-e1-k1', 'dx-d1-1h-c0-e1-k1'])).toEqual([
      'missing dx-d1-1h-c0-e1-k1.json',
      'stray dx-d9-1h-c0-e1-k1.json',
    ]);
    expect(directoryProblems(files, ['dx-d0-1h-c0-e1-k1'], (n) => n === 'dx-d9-1h-c0-e1-k1')).toEqual([]);
  });

  it('rejects a report that fails the harness report schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dx-reports-'));
    writeFileSync(join(dir, 'dx-d0-1h-c0-e1-k1.json'), '{}');
    expect(() => loadReports(dir, ['dx-d0-1h-c0-e1-k1'])).toThrow(/schema/);
    expect(() => loadReports(dir, ['dx-d0-1h-c0-e1-k1', 'dx-d1-1h-c0-e1-k1'])).toThrow(/missing dx-d1/);
  });
});
