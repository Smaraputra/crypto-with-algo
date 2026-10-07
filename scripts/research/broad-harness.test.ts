// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { computeBroadGate8, formatBroadGate8, parseArgs as parseDsrArgs } from './broad-dsr';
import { syntheticBroadInputs } from './broad-fixtures';
import { BROAD_TRIAL_IDS, topContributors } from './broad-gates';
import {
  DEFAULT_CALENDAR,
  assertInCalendar,
  broadOptions,
  broadRulePaths,
  everyMonth,
  formatBroad,
  nullSizeCheck,
  pairPoint,
  parseArgs,
  permuteReturns,
  rangeFrom,
  runBroadStudy,
  runPair,
  stressOptions,
  twinPaths,
} from './broad-harness';
import { BROAD_COST, BROAD_FEE } from './broad-trend';
import { broadTrialsFrom } from './legends-dsr';
import { validateBroadTrendReport, type BroadTrendReport } from './report-schema';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { DAY_MS, type TrendRuleId } from './trend-signals';
import { annualAlpha, assertBroadInput, runTrend, type TrendSymbolInput } from './trend-sim';

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const loaded = syntheticBroadInputs();
const FAST = { draws: 3, nullSizeUniverses: 1, nullSizeDraws: 2, bootstrapDraws: 40, gitCommit: 'test' };

describe('parseArgs', () => {
  const required = ['--rule', 'TF4', '--dataset-dir', '/d', '--universe-file', '/u.json', '--out', '/o.json', '--task-id', 'tf4'];

  it('reads the required flags and defaults to 200 draws and 50 null-size universes', () => {
    expect(parseArgs(required)).toEqual({
      rule: 'TF4',
      datasetDir: '/d',
      universeFile: '/u.json',
      out: '/o.json',
      taskId: 'tf4',
      draws: 200,
      nullSizeUniverses: 50,
    });
    expect(parseArgs([...required, '--draws', '10', '--null-size-universes', '0'])).toMatchObject({ draws: 10, nullSizeUniverses: 0 });
  });

  it('refuses a missing flag, an unknown flag, a bad rule and bad counts', () => {
    expect(() => parseArgs(required.slice(0, 8))).toThrow(/--task-id is required/);
    expect(() => parseArgs([...required, '--symbols', 'A'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--rule', 'TF5', ...required.slice(2)])).toThrow(/--rule must be one of/);
    expect(() => parseArgs([...required, '--draws', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs([...required, '--null-size-universes', '-1'])).toThrow(/non-negative/);
  });
});

describe('container options', () => {
  it('base: the taker fee with the broad tiers; stress: 1.5x fee, 2x tiers and leave slippage, 4% haircut (5% reported)', () => {
    const base = broadOptions(utc(2021, 3, 1), utc(2026, 7, 1));
    expect(base.cost).toEqual(BROAD_FEE);
    expect(base.broad).toBe(BROAD_COST);
    expect(base.delay).toBe(0);
    const stress = stressOptions(base);
    expect(stress.cost.fee).toBeCloseTo(0.00075, 15);
    expect(stress.cost.slippage).toBe(0);
    expect([5, 20, 40].map(stress.broad!.slippageForRank)).toEqual([0.0004, 0.001, 0.002]);
    expect(stress.broad!.leaveSlippage).toBe(0.002);
    expect(stress.broad!.delistHaircut).toBe(0.04);
    expect(stressOptions(base, 0.05).broad!.delistHaircut).toBe(0.05);
    expect(stressOptions(base, 0.05).broad!.slippageForRank(5)).toBe(0.0004);
  });

  it('everyMonth spans each ranking close to the next, the last to the end', () => {
    expect(everyMonth(utc(2021, 3, 1), utc(2021, 5, 1))).toEqual([
      { from: utc(2021, 3, 1), to: utc(2021, 4, 1), rank: 1 },
      { from: utc(2021, 4, 1), to: utc(2021, 5, 1), rank: 1 },
    ]);
  });

  it('rangeFrom starts at the first defined day, empty when there is none', () => {
    const days = [10, 20, 30];
    expect(rangeFrom(days, 20)).toEqual({ first: 1, last: 2 });
    expect(rangeFrom(days, null)).toEqual({ first: 3, last: 2 });
  });
});

describe('assertInCalendar', () => {
  it('refuses a bar outside 2020-01-01 to 2026-06-30 before any return is computed', () => {
    const early: TrendSymbolInput = { ...loaded.inputs[0], t: loaded.inputs[0].t.map((t) => t - 30 * DAY_MS) };
    expect(() => assertInCalendar([early])).toThrow(/2019-12-02 .* outside the null calendar 2020-01-01 to 2026-06-30/);
    expect(() => assertInCalendar(loaded.inputs, DEFAULT_CALENDAR)).not.toThrow();
  });
});

describe('permuteReturns (gate 4 null size)', () => {
  const ccc = loaded.inputs.find((i) => i.symbol === 'CCCUSDT#1')!;
  const permuted = permuteReturns(ccc, createSeededRandom(11));
  const realReturns = (input: TrendSymbolInput) =>
    input.t
      .map((_, i) => i)
      .filter((i) => i > 0 && input.carried![i] !== 1)
      .map((i) => input.close[i] / input.close[i - 1] - 1);

  it('permutes the real days\' returns, keeping their multiset, the first close and the carried days', () => {
    const a = realReturns(ccc).sort((x, y) => x - y);
    const b = realReturns(permuted).sort((x, y) => x - y);
    expect(b.length).toBe(a.length);
    b.forEach((r, k) => expect(r).toBeCloseTo(a[k], 10));
    expect(realReturns(permuted)).not.toEqual(realReturns(ccc));
    expect(permuted.close[0]).toBe(ccc.close[0]);
    expect(permuted.carried).toBe(ccc.carried);
    for (let i = 1; i < permuted.t.length; i++) expect(permuted.open[i]).toBe(permuted.close[i - 1]);
    expect(() => assertBroadInput(permuted)).not.toThrow();
    expect(permuted.settlements).toBe(ccc.settlements);
    expect(permuted.membership).toBe(ccc.membership);
  });
});

describe('nullSizeCheck', () => {
  const base = broadOptions(loaded.from, loaded.to);

  it('runs the rule, its twin and both nulls on each permuted universe, deterministically', () => {
    const a = nullSizeCheck({ rule: 'TF3', loaded, opts: base, universes: 2, draws: 2 });
    expect(a.perUniverse).toHaveLength(2);
    expect(a.seed).toBe(11);
    for (const u of a.perUniverse) {
      expect(u.wrappedP).not.toBeNull();
      expect([1 / 3, 2 / 3, 1]).toContainEqual(u.alignedP);
    }
    expect(a.rates.both).toBeLessThanOrEqual(Math.min(a.rates.wrapped, a.rates.aligned));
    expect(nullSizeCheck({ rule: 'TF3', loaded, opts: base, universes: 2, draws: 2 })).toEqual(a);
    // Different universes, different observed alphas.
    expect(a.perUniverse[0].observedAlpha).not.toBe(a.perUniverse[1].observedAlpha);
  });
});

describe('runBroadStudy on a synthetic universe', () => {
  const reports = Object.fromEntries(
    BROAD_TRIAL_IDS.map((rule) => [rule, runBroadStudy({ rule, taskId: rule.toLowerCase() }, loaded, FAST)])
  ) as Record<TrendRuleId, BroadTrendReport>;

  it.each(BROAD_TRIAL_IDS)('%s writes a schema v2 report with nine gates, gate 8 pending', (rule) => {
    const r = reports[rule];
    expect(validateBroadTrendReport(JSON.parse(JSON.stringify(r))).ok).toBe(true);
    expect(r.schemaVersion).toBe(2);
    expect(r.gates.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.gates[7]).toMatchObject({ name: 'trials', pass: null });
    expect(['fail', 'pending-trials']).toContain(r.verdict);
    expect(r.daily.returns).toHaveLength(r.sample.days);
    expect(r.daily.days[0]).toBe(r.sample.firstDefinedDay);
    expect(r.universe.sha256).toBe(loaded.universe.sha256);
    expect(r.datasetManifestHash).toBe(loaded.datasetHash);
    expect(r.parameters.nullDraws).toBe(3);
    expect(r.nullSize!.perUniverse).toHaveLength(1);
    expect(formatBroad(r)).toMatch(new RegExp(`^${rule}: 9 member contracts \\(9 in the basket\\)`));
  });

  it('gate values are the report\'s statistics', () => {
    const r = reports.TF4;
    const gate = (name: string) => r.gates.find((g) => g.name === name)!;
    expect(gate('sample').value).toBe(r.sample.days);
    expect(gate('expectancy').value).toBe(r.sharpe.low);
    expect(gate('twin').value).toBe(r.alpha.low);
    expect(gate('timing').value).toBe(Math.max(r.timing.wrapped.p!, r.timing.aligned.p!));
    expect(r.timing.gatingP).toBe(gate('timing').value);
    expect(gate('stress').value).toBe(r.stress.alpha);
    expect(gate('ex2021').value).toBe(r.ex2021.alpha);
    const drops = [...r.cohorts.listingYears, r.cohorts.legendsTen, r.cohorts.btcEth, r.cohorts.top5];
    expect(gate('cohorts').threshold).toBe(drops.length);
    expect(gate('cohorts').value).toBe(drops.filter((d) => d.alpha !== null && d.alpha > 0).length);
  });

  it('the sample starts at the first defined member day: from the universe start for TF1 to TF4 here', () => {
    // Every member has 366 bars at its first close, so even TF4's 359-bar Donchian is defined from day one.
    for (const rule of ['TF1', 'TF2', 'TF3', 'TF4'] as const) expect(reports[rule].sample.firstDefinedDay).toBe(loaded.from);
    // C3 needs basket position 393 (from 2020-02-01): the decision of 2021-02-28 is the first defined one.
    expect(reports.C3.sample.firstDefinedDay).toBe(utc(2021, 3, 1));
    expect(reports.TF4.sample.days).toBe((loaded.to - loaded.from) / DAY_MS);
  });

  it('cohort drops re-run the rule and its twin without those contracts, paths unchanged', () => {
    const r = reports.C3;
    const base = broadOptions(loaded.from, loaded.to);
    const { paths } = broadRulePaths('C3', loaded);
    const range = rangeFrom(runTrend(loaded.inputs, paths, base).days, r.sample.firstDefinedDay);
    const btcEth = new Set(r.cohorts.btcEth.contracts);
    expect([...btcEth]).toEqual(['BTCUSDT#1', 'ETHUSDT#1']);
    const rest = loaded.inputs.filter((i) => !btcEth.has(i.symbol));
    expect(pairPoint(runPair(rest, paths, twinPaths(paths), base), range).alpha).toBe(r.cohorts.btcEth.alpha);
    expect(r.cohorts.legendsTen.contracts).toEqual(['BTCUSDT#1', 'ETHUSDT#1', 'SOLUSDT#1']);
    // Every member contract sits in exactly one listing-year cohort.
    const all = r.cohorts.listingYears.flatMap((c) => c.contracts).sort();
    expect(all).toEqual(loaded.inputs.map((i) => i.symbol).sort());
    const shares = r.cohorts.listingYears.reduce((s, c) => s + (c.share ?? 0), 0);
    expect(shares).toBeCloseTo(1, 12);
  });

  it('the top five are the largest contributors to T minus beta times T+', () => {
    const r = reports.TF1;
    const base = broadOptions(loaded.from, loaded.to);
    const { paths } = broadRulePaths('TF1', loaded);
    const pair = runPair(loaded.inputs, paths, twinPaths(paths), base);
    const range = rangeFrom(pair.t.days, r.sample.firstDefinedDay);
    const tR = pair.t.returns.slice(range.first, range.last + 1);
    const wR = pair.twin.returns.slice(range.first, range.last + 1);
    const { beta } = annualAlpha(tR, wR);
    expect(r.cohorts.top5.contributions).toEqual(topContributors(pair.t.contributions, pair.twin.contributions, beta, range));
    expect(r.cohorts.top5.contracts).toEqual(r.cohorts.top5.contributions.map((c) => c.contract).sort());
    expect(r.cohorts.top5.contracts).toHaveLength(5);
  });

  it('reports the member counts, the delistings with their PnL, the leaves, the benchmarks and the funding', () => {
    const r = reports.TF3;
    expect(r.membersPerMonth[0]).toMatchObject({ close: '2021-01-01', members: 3 });
    expect(r.membersPerMonth).toHaveLength(66);
    for (const m of r.membersPerMonth) expect(m.live).toBeLessThanOrEqual(m.members);
    for (const d of r.delistings) expect(['BBBUSDT#1', 'DDDUSDT#1']).toContain(d.contract);
    // The always-long twin holds both delisting members on their last day.
    const base = broadOptions(loaded.from, loaded.to);
    const { paths } = broadRulePaths('TF3', loaded);
    const twin = runTrend(loaded.inputs, twinPaths(paths), base);
    expect(twin.broad!.delistings.map((d) => [d.symbol, d.day])).toEqual([
      ['BBBUSDT#1', utc(2023, 5, 10)],
      ['DDDUSDT#1', utc(2024, 4, 7)],
    ]);
    expect(r.leaves.count).toBeGreaterThan(0);
    expect(r.benchmarks.btc.available).toBe(true);
    expect(r.benchmarks.btc.note).toMatch(/BTCUSDT#1 held at 1x/);
    expect(r.benchmarks.memberBasket.available).toBe(true);
    expect(r.carriedDays).toEqual({ 'CCCUSDT#1': 3 });
    expect(r.funding.byInterval['4']).toBeGreaterThan(0);
    expect(r.years.map((y) => y.year)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(r.timing.wrapped.misalignedShare).not.toBeNull();
    expect(r.timing.aligned.misalignedShare).toBe(0);
    expect(r.timing.aligned.outsideLifeShare).toBeGreaterThan(0);
  });

  it('is deterministic: the same inputs give the same report but for the clock', () => {
    const again = runBroadStudy({ rule: 'TF2', taskId: 'tf2' }, loaded, FAST);
    const strip = (r: BroadTrendReport) => ({ ...r, computedAt: '', durationMs: 0 });
    expect(strip(again)).toEqual(strip(reports.TF2));
  });

  it('feeds broad-dsr: gate 8 at N = 16 across the five, the floor at the shortest series, the program count beside', () => {
    const trials = broadTrialsFrom(BROAD_TRIAL_IDS.map((rule) => JSON.parse(JSON.stringify(reports[rule]))));
    const g = computeBroadGate8(trials);
    expect(g.numTrials).toBe(16);
    expect(g.programTrials).toBe(1729);
    expect(g.result.trials).toBe(16);
    const shortest = Math.min(...BROAD_TRIAL_IDS.map((rule) => reports[rule].daily.returns.length));
    expect(g.variance.floorObservations).toBe(shortest);
    expect(g.variance.used).toBe(Math.max(g.variance.crossTrial, 1 / (shortest - 1)));
    expect(Object.keys(g.verdicts).sort()).toEqual([...BROAD_TRIAL_IDS].sort());
    for (const r of g.result.results) {
      const report = reports[r.id as TrendRuleId];
      expect(r.days).toBe(report.daily.returns.length);
      if (report.verdict === 'fail') expect(g.verdicts[r.id]).toBe('fail');
    }
    expect(formatBroadGate8(g)).toMatch(/at N = 16, .* at N = 1729/);
  });

  it('broad-dsr refuses a missing rule, a duplicate and reports from different exports', () => {
    const json = (rule: TrendRuleId) => JSON.parse(JSON.stringify(reports[rule]));
    expect(() => broadTrialsFrom(['TF1', 'TF2', 'TF3', 'TF4'].map((r) => json(r as TrendRuleId)))).toThrow(/got TF1,TF2,TF3,TF4/);
    expect(() => broadTrialsFrom([json('TF1'), json('TF1'), json('TF3'), json('TF4'), json('C3')])).toThrow(/two reports for TF1/);
    const other = { ...json('C3'), datasetManifestHash: 'another' };
    expect(() => broadTrialsFrom([json('TF1'), json('TF2'), json('TF3'), json('TF4'), other])).toThrow(/2 exports/);
    expect(() => broadTrialsFrom([{ schemaVersion: 1 }], ['x.json'])).toThrow(/^x.json:/);
    expect(parseDsrArgs(['--reports', 'a.json,b.json', '--out', 'g.json'])).toEqual({ reports: ['a.json', 'b.json'], out: 'g.json' });
    expect(() => parseDsrArgs(['--out', 'g.json'])).toThrow(/--reports is required/);
  });
});

describe('the twin and the rule share one schedule', () => {
  it('a rule whose signal is the twin\'s has zero alpha against it', () => {
    const base = broadOptions(loaded.from, loaded.to);
    const { paths } = broadRulePaths('TF3', loaded);
    const twin = twinPaths(paths);
    const pair = runPair(loaded.inputs, twin, twin, base);
    const range = rangeFrom(pair.t.days, loaded.from);
    expect(pairPoint(pair, range).alpha).toBeCloseTo(0, 12);
    expect(pairPoint(pair, range).beta).toBeCloseTo(1, 12);
  });
});
