// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeSyntheticExport } from './broad-fixtures';
import { FLOW_TRIAL_IDS, FLOW_RULE_IDS, flowSchedule, flowSimOptions, flowValues, plainValueAt, type FlowRuleId } from './broad-flow';
import { computeFlowGate7, flowTrialsFrom, formatFlowGate7, parseArgs as parseDsrArgs } from './broad-flow-dsr';
import { FLOW_OPTIONS, flowInputsOf, flowUniverse, plantedUniverse } from './broad-flow-fixtures';
import { exposureStat, formatFlow, loadFlowInputs, parseArgs, quantile, runBook, runBroadFlowStudy, runPoint } from './broad-flow-harness';
import { topContributors } from './broad-gates';
import { broadOptions } from './broad-harness';
import { segmentContracts, universeFile } from './broad-trend';
import { validateBroadFlowReport, type BroadFlowReport } from './report-schema';
import { DAY_MS } from './trend-signals';
import { runTrend } from './trend-sim';

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const u = flowUniverse();
const loaded = flowInputsOf(u);
const FAST = { draws: 3, bootstrapDraws: 40, gitCommit: 'test' };

describe('parseArgs', () => {
  const required = ['--rule', 'DO', '--dataset-dir', '/d', '--universe-file', '/u.json', '--out', '/o.json', '--task-id', 'do'];

  it('reads the required flags and defaults to 200 draws', () => {
    expect(parseArgs(required)).toEqual({ rule: 'DO', datasetDir: '/d', universeFile: '/u.json', out: '/o.json', taskId: 'do', draws: 200 });
    expect(parseArgs([...required, '--draws', '10']).draws).toBe(10);
    for (const rule of FLOW_RULE_IDS) expect(parseArgs(['--rule', rule, ...required.slice(2)]).rule).toBe(rule);
  });

  it('refuses a missing flag, an unknown flag, a bad rule and a bad draw count', () => {
    expect(() => parseArgs(required.slice(0, 8))).toThrow(/--task-id is required/);
    expect(() => parseArgs([...required, '--null-size-universes', '1'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--rule', 'TF4', ...required.slice(2)])).toThrow(/--rule must be one of DO, W, WO, D/);
    expect(() => parseArgs([...required, '--draws', '0'])).toThrow(/positive integer/);
  });
});

describe('helpers', () => {
  it('quantile interpolates; exposureStat summarises a series', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.05)).toBeCloseTo(0.5, 12);
    expect(quantile([], 0.5)).toBeNaN();
    expect(exposureStat([-2, 1, 1])).toMatchObject({ mean: 0, meanAbs: 4 / 3, maxAbs: 2 });
    expect(exposureStat([])).toEqual({ mean: null, meanAbs: null, p05: null, p95: null, maxAbs: null });
  });
});

describe('loadFlowInputs from an export directory', () => {
  let dir: string;
  let universePath: string;
  let hash: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'broad-flow-'));
    hash = await writeSyntheticExport(join(dir, 'export'), u);
    const contracts = Object.keys(u.perp)
      .sort()
      .flatMap((s) => segmentContracts(s, u.perp[s]));
    const file = universeFile({ sourceDatasetHash: hash, contracts, universe: FLOW_OPTIONS.universe, basket: FLOW_OPTIONS.basket });
    universePath = join(dir, 'universe.json');
    writeFileSync(universePath, `${JSON.stringify(file, null, 1)}\n`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('verifies the export and the universe file, then builds the same inputs and bars as in memory', async () => {
    const fromDisk = await loadFlowInputs(join(dir, 'export'), universePath, { preregistered: false });
    expect(fromDisk.datasetHash).toBe(hash);
    const memory = flowInputsOf({ ...u, datasetHash: hash, universe: fromDisk.universe });
    expect(fromDisk.inputs.map((i) => i.symbol)).toEqual(memory.inputs.map((i) => i.symbol));
    expect(fromDisk.bars).toEqual(memory.bars);
    expect(Object.values(fromDisk.bars).every((rows) => rows.every((r) => r.tbv !== null))).toBe(true);
    await expect(loadFlowInputs(join(dir, 'export'), universePath)).rejects.toThrow(/pre-registered/);
  });
});

describe('runBroadFlowStudy on a synthetic universe', () => {
  const reports = Object.fromEntries(
    FLOW_RULE_IDS.map((rule) => [rule, runBroadFlowStudy({ rule, taskId: rule.toLowerCase() }, loaded, FAST)])
  ) as Record<FlowRuleId, BroadFlowReport>;

  it.each(FLOW_RULE_IDS)('%s writes a schema v3 report that round-trips, eight gates, gate 7 undecided', (rule) => {
    const r = reports[rule];
    const parsed = validateBroadFlowReport(JSON.parse(JSON.stringify(r)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data).toEqual(r);
    expect(r.schemaVersion).toBe(3);
    expect(r.phase).toBe('broad-flow');
    expect(r.gates.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.gates[6]).toMatchObject({ name: 'trials', pass: null });
    expect(r.role).toBe(rule === 'D' ? 'control' : 'trial');
    if (rule === 'D') expect(r.verdict).toBe('control');
    else expect(['fail', 'pending-trials']).toContain(r.verdict);
    expect(r.daily.returns).toHaveLength(r.sample.days);
    expect(r.daily.days[0]).toBe(r.sample.firstPositionDay);
    expect(r.universe.sha256).toBe(loaded.universe.sha256);
    expect(r.datasetManifestHash).toBe(loaded.datasetHash);
    expect(r.parameters.nullDraws).toBe(3);
    expect(r.parameters.bootstrapDraws).toBe(40);
    expect(formatFlow(r)).toMatch(new RegExp(`^${rule} \\(${r.role}, ${r.parameters.frequency}`));
  });

  it('records each rule\'s frequency, orthogonalisation and the aligned null\'s unit', () => {
    expect(reports.DO.parameters).toMatchObject({ frequency: 'daily', orthogonalised: true, minShift: 365, nullCalendarDays: 2373 });
    expect(reports.W.parameters).toMatchObject({ frequency: 'weekly', orthogonalised: false, minShift: 52, nullCalendarWeeks: 338 });
    expect(reports.WO.parameters).toMatchObject({ frequency: 'weekly', orthogonalised: true });
    expect(reports.D.parameters).toMatchObject({ frequency: 'daily', orthogonalised: false });
    expect(reports.DO.timing.aligned).toMatchObject({ shiftUnit: 'days', draws: 3 });
    expect(reports.W.timing.aligned.shiftUnit).toBe('weeks');
    expect(reports.W.timing.aligned.shifts.every((k) => k >= 52 && k <= 286)).toBe(true);
    expect(reports.DO.timing.aligned.shifts.every((k) => k >= 365 && k <= 2008)).toBe(true);
    expect(reports.DO.timing.permuted).toMatchObject({ shiftUnit: null, shifts: [], outsideLifeShare: null });
    expect(reports.DO.orthogonalisation!.definedPeriods).toBe(reports.DO.orthogonalisation!.periods);
    expect(reports.WO.orthogonalisation!.yearEnds.map((f) => new Date(f.close - DAY_MS).getUTCFullYear())).toEqual([
      2021, 2022, 2023, 2024, 2025, 2026,
    ]);
    expect(reports.D.orthogonalisation).toBeNull();
    expect(reports.W.orthogonalisation).toBeNull();
  });

  it('gate values are the report\'s statistics', () => {
    for (const rule of FLOW_RULE_IDS) {
      const r = reports[rule];
      const gate = (name: string) => r.gates.find((g) => g.name === name)!;
      expect(gate('sample').value).toBe(r.sample.days);
      expect(gate('expectancy').value).toBe(r.sharpe.low);
      expect(gate('timing').value).toBe(Math.max(r.timing.permuted.p!, r.timing.aligned.p!));
      expect(r.timing.gatingP).toBe(gate('timing').value);
      expect(gate('stress').value).toBe(r.stress.mean);
      expect(gate('after-paper').value).toBe(r.afterPaper.mean);
      const drops = [...r.cohorts.listingYears, r.cohorts.legendsTen, r.cohorts.btcEth, r.cohorts.top5];
      expect(gate('cohorts').threshold).toBe(drops.length);
      expect(gate('cohorts').value).toBe(drops.filter((d) => d.mean !== null && d.mean > 0).length);
      const gated = r.years.filter((y) => y.year <= 2025);
      expect(gate('years').value).toBe(gated.filter((y) => y.mean !== null && y.mean > 0).length / 5);
    }
  });

  it('the sample starts on the first day the book holds a position; the daily book is dollar-neutral at every fill', () => {
    // Every member has 366 bars at the start close, so OF is defined there and the book holds from day one.
    expect(reports.D.sample.firstPositionDay).toBe(loaded.from);
    expect(reports.DO.sample.firstPositionDay).toBe(loaded.from);
    // The weekly books hold from the open after the first Saturday close (2021-01-02).
    expect(reports.W.sample.firstPositionDay).toBe(utc(2021, 1, 2));
    expect(reports.D.sample.days).toBe((loaded.to - loaded.from) / DAY_MS);
    for (const rule of ['D', 'DO'] as const) {
      expect(reports[rule].exposure.netAtFill.maxAbs).toBeLessThan(1e-9);
      // Gross at the fill is 2q / M of equity: 4 / 12 here, less any cash.
      expect(reports[rule].exposure.grossAtFill.p95).toBeCloseTo(4 / 12, 9);
    }
    expect(reports.W.exposure.netAtFill.maxAbs).toBeGreaterThan(1e-6);
    expect(reports.DO.periods.list).toHaveLength(reports.DO.sample.days);
    expect(reports.W.periods.count).toBe(287);
    expect(reports.DO.periods).toMatchObject({ qMin: 2, qMax: 2, flat: 0 });
  });

  it('cohort drops re-rank the remaining members with the values unchanged', () => {
    const r = reports.D;
    const base = flowSimOptions(broadOptions(loaded.from, loaded.to), 'daily');
    const schedule = flowSchedule(loaded.inputs, 'daily', loaded.from, loaded.to);
    const values = flowValues('D', loaded.inputs, loaded.bars, schedule).values;
    const btcEth = new Set(r.cohorts.btcEth.contracts);
    expect([...btcEth]).toEqual(['BTCUSDT#1', 'ETHUSDT#1']);
    const rest = loaded.inputs.filter((i) => !btcEth.has(i.symbol));
    const range = { first: 0, last: r.sample.days - 1 };
    const dropped = runBook(rest, 'daily', (subset) => plainValueAt(subset, values), base);
    expect(runPoint(dropped.run, range).mean).toBe(r.cohorts.btcEth.mean);
    // Ten members remain at most: q = 2 while ten are ranked, flat below.
    expect(Math.max(...dropped.book.periods.map((p) => p.ranked))).toBeLessThanOrEqual(10);
    expect(r.cohorts.legendsTen.contracts).toEqual(['BTCUSDT#1', 'ETHUSDT#1', 'SOLUSDT#1']);
    const all = r.cohorts.listingYears.flatMap((c) => c.contracts).sort();
    expect(all).toEqual(loaded.inputs.map((i) => i.symbol).sort());
  });

  it('the top five are the largest summed contributions to the book\'s return', () => {
    const r = reports.DO;
    const base = flowSimOptions(broadOptions(loaded.from, loaded.to), 'daily');
    const schedule = flowSchedule(loaded.inputs, 'daily', loaded.from, loaded.to);
    const values = flowValues('DO', loaded.inputs, loaded.bars, schedule).values;
    const main = runBook(loaded.inputs, 'daily', (subset) => plainValueAt(subset, values), base).run;
    const range = { first: 0, last: main.days.length - 1 };
    expect(r.daily.returns).toEqual(main.returns);
    expect(r.cohorts.top5.contributions).toEqual(topContributors(main.contributions, {}, 0, range));
    expect(r.cohorts.top5.contracts).toEqual(r.cohorts.top5.contributions.map((c) => c.contract).sort());
    expect(r.cohorts.top5.contracts).toHaveLength(5);
    // The stress run (1.5x fee, 2x tiers, 4% haircut) costs more than the base run.
    expect(r.stress.mean!).toBeLessThan(r.meanDaily!);
    expect(runTrend(loaded.inputs, runBook(loaded.inputs, 'daily', (s) => plainValueAt(s, values), base).book.paths, base).returns).toEqual(
      main.returns
    );
  });

  it('reports benchmarks, legs, per-year costs, windows, the delay, delistings, leaves and coverage', () => {
    const r = reports.DO;
    expect(r.benchmarks.btc).toMatchObject({ available: true });
    expect(r.benchmarks.btc.note).toMatch(/BTCUSDT#1 held at 1x/);
    expect(r.benchmarks.memberBasket.available).toBe(true);
    expect(r.perYear.map((y) => y.year)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(r.perYear.reduce((s, y) => s + y.days, 0)).toBe(r.sample.days);
    expect(r.perYear[0].costAnnual).toBeGreaterThan(0);
    expect(r.paperOverlap).toMatchObject({ from: utc(2021, 3, 1), to: utc(2022, 7, 1), days: 487 });
    expect(r.afterPaper.days).toBe((utc(2026, 7, 1) - utc(2022, 7, 1)) / DAY_MS);
    expect(r.delay1.sharpe).not.toBe(r.sharpe.point);
    expect(r.delistings.map((d) => d.contract)).toEqual(r.delistings.length > 0 ? ['KKKUSDT#1'] : []);
    expect(r.leaves.count).toBeGreaterThan(0);
    expect(r.carriedDays).toEqual({ 'LLLUSDT#1': 3 });
    expect(r.coverage.rankedMemberPeriods).toBeLessThanOrEqual(r.coverage.memberPeriods);
    expect(r.coverage.unknownBuyDays).toEqual({});
    expect(r.funding.byInterval['4']).toBeGreaterThan(0);
    expect(r.years.map((y) => y.year)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
  });

  it('is deterministic: the same inputs give the same report but for the clock', () => {
    const again = runBroadFlowStudy({ rule: 'WO', taskId: 'wo' }, loaded, FAST);
    const strip = (r: BroadFlowReport) => ({ ...r, computedAt: '', durationMs: 0 });
    expect(strip(again)).toEqual(strip(reports.WO));
  });

  it('feeds gate 7: N = 3 across DO, W and WO, the floor at the shortest series, the program count 1,732 beside', () => {
    const trials = flowTrialsFrom(FLOW_TRIAL_IDS.map((rule) => JSON.parse(JSON.stringify(reports[rule]))));
    const g = computeFlowGate7(trials);
    expect(g.numTrials).toBe(3);
    expect(g.programTrials).toBe(1732);
    expect(g.result.trials).toBe(3);
    const shortest = Math.min(...FLOW_TRIAL_IDS.map((rule) => reports[rule].daily.returns.length));
    expect(g.variance.mode).toBe('max-cross-sampling');
    expect(g.variance.floorObservations).toBe(shortest);
    expect(g.variance.used).toBe(Math.max(g.variance.crossTrial, 1 / (shortest - 1)));
    expect(Object.keys(g.verdicts).sort()).toEqual([...FLOW_TRIAL_IDS].sort());
    for (const res of g.result.results) {
      const report = reports[res.id as FlowRuleId];
      expect(res.days).toBe(report.daily.returns.length);
      expect(res.dsrProgram).toBeLessThanOrEqual(res.dsrPhase);
      if (report.verdict === 'fail') expect(g.verdicts[res.id]).toBe('fail');
    }
    expect(g.result.expectedMaxAnnualSharpeProgram).toBeGreaterThan(g.result.expectedMaxAnnualSharpePhase);
    expect(formatFlowGate7(g)).toMatch(/^V = .*\ngate 7 across 3 trials: .* at N = 3, .* at N = 1732/);
  });

  it('gate 7 refuses the control, a missing trial, a duplicate and reports from different exports', () => {
    const json = (rule: FlowRuleId) => JSON.parse(JSON.stringify(reports[rule]));
    expect(() => flowTrialsFrom([json('DO'), json('W'), json('D')])).toThrow(/D is the control, not a trial/);
    expect(() => flowTrialsFrom([json('DO'), json('W')])).toThrow(/got DO,W/);
    expect(() => flowTrialsFrom([json('DO'), json('DO'), json('WO')])).toThrow(/two reports for DO/);
    expect(() => flowTrialsFrom([json('DO'), json('W'), { ...json('WO'), datasetManifestHash: 'other' }])).toThrow(/2 exports/);
    expect(() => flowTrialsFrom([json('DO'), json('W'), { ...json('WO'), universe: { ...json('WO').universe, sha256: 'x' } }])).toThrow(
      /2 universes/
    );
    expect(() => flowTrialsFrom([{ schemaVersion: 2 }], ['x.json'])).toThrow(/^x.json:/);
    expect(parseDsrArgs(['--reports', 'a.json,b.json,c.json', '--out', 'g.json'])).toEqual({
      reports: ['a.json', 'b.json', 'c.json'],
      out: 'g.json',
    });
    expect(() => parseDsrArgs(['--out', 'g.json'])).toThrow(/--reports is required/);
  });
});

describe('planted flow: the pipeline is causal', () => {
  const draws = 9;
  const run = (lag: 0 | 1, rule: FlowRuleId) =>
    runBroadFlowStudy({ rule, taskId: `${rule}-${lag}` }, flowInputsOf(plantedUniverse(12, 0.1, lag)), { draws, bootstrapDraws: 40 });

  it('flow that predicts the next day\'s return is found by D and DO, and both nulls reject at their floor', () => {
    for (const rule of ['D', 'DO'] as const) {
      const r = run(1, rule);
      expect(r.sharpe.point!).toBeGreaterThan(5);
      expect(r.sharpe.low!).toBeGreaterThan(0);
      expect(r.timing.permuted.p).toBe(1 / (draws + 1));
      expect(r.timing.aligned.p).toBe(1 / (draws + 1));
      // Held one day late, the one-day edge is gone.
      expect(r.delay1.sharpe!).toBeLessThan(1);
    }
  });

  it('flow that moves with the same day\'s return predicts nothing after the decision close', () => {
    for (const rule of ['D', 'DO'] as const) {
      const r = run(0, rule);
      expect(r.sharpe.point!).toBeLessThan(1);
      expect(r.timing.permuted.p).toBeGreaterThan(0.1);
    }
    // DO removes the same-day return: its fit has a large positive slope.
    expect(run(0, 'DO').orthogonalisation!.final!.beta).toBeGreaterThan(1);
  });
});
