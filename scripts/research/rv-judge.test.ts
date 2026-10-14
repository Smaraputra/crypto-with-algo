// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { normalCdf, normalQuantile, sampleKurtosis, sampleSkewness } from '@/lib/stats/normal';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { CALIBRATION_UNIVERSES, RV_SEEDS, RV_WF_GEOMETRY, type NullLine } from './rv-mcpt';
import { syntheticPanel } from './rv-synthetic';
import {
  FUNDING_MARK_NOTE,
  calibrationJobs,
  loadInputs,
  runRealStage,
  shardJobs,
  stageSeed,
  writeInputs,
  type CalibrationOutput,
  type LoadedInputs,
  type Provenance,
  type RealOutput,
  type ShardStage,
} from './rv-stages';
import {
  CARRY_ONLY_NOTE,
  DSR_GATE_TRIALS,
  type CalibrationEvidence,
  DSR_REPORTED_TRIALS,
  checkCalibration,
  jobLines,
  judgeVerdict,
  kolmogorovCdf,
  ksUniform,
  mergeShards,
  rvDsr,
  seriesStats,
  verifiedRealStage,
} from './rv-judge';

const COMMIT = 'a'.repeat(40);
const PROV: Provenance = { manifestHash: 'c'.repeat(64), panelSha256: 'e'.repeat(64), gitCommit: COMMIT };
const GAMMA = 0.5772156649;

describe('ksUniform (header CALIBRATION: Kolmogorov-Smirnov p against uniform)', () => {
  it('matches the exact distribution for n = 1 and the classic critical values', () => {
    expect(kolmogorovCdf(1, 0.75)).toBeCloseTo(0.5, 12);
    expect(kolmogorovCdf(1, 0.4)).toBe(0);
    // Massey (1951): n = 20 at 5% is 0.294, n = 30 at 1% is 0.290, n = 100 at 1% is about 1.63 / sqrt(100)
    expect(kolmogorovCdf(20, 0.294)).toBeCloseTo(0.95, 2);
    expect(kolmogorovCdf(30, 0.29)).toBeCloseTo(0.99, 2);
    expect(kolmogorovCdf(100, 0.1627)).toBeCloseTo(0.99, 2);
  });

  it('agrees with a Monte Carlo of uniform samples', () => {
    const random = createSeededRandom(99);
    const ds: number[] = [];
    for (let r = 0; r < 20_000; r++) ds.push(ksUniform(Array.from({ length: 20 }, () => random())).d);
    for (const d of [0.15, 0.2, 0.25, 0.3]) {
      const empirical = ds.filter((x) => x < d).length / ds.length;
      expect(Math.abs(empirical - kolmogorovCdf(20, d))).toBeLessThan(0.012);
    }
  });

  it('computes D over the sorted sample and p = 1 - P(D_n < D)', () => {
    const { d, p, n } = ksUniform([0.9, 0.1, 0.5]);
    expect(n).toBe(3);
    // sorted 0.1, 0.5, 0.9: max over i of i/n - x and x - (i - 1)/n is 1/3 - 0.1 = 0.2333
    expect(d).toBeCloseTo(1 / 3 - 0.1, 12);
    expect(p).toBeCloseTo(1 - kolmogorovCdf(3, d), 12);
    expect(ksUniform(Array.from({ length: 50 }, (_, i) => 0.001 + i * 0.0001)).p).toBeLessThan(1e-10);
    expect(() => ksUniform([0.5, 1.2])).toThrow(/\[0, 1\]/);
    expect(() => ksUniform([])).toThrow(/empty/);
  });
});

describe('rvDsr (header VERDICT G3, N = 672, V floor 1 / (T - 1))', () => {
  /** Hand computation of the deflated Sharpe, written from Bailey and Lopez de Prado (2014). */
  function hand(series: number[][], N: number, cell = 11) {
    const sharpes = series.map((s) => perPeriodSharpe(s));
    const mean = sharpes.reduce((a, b) => a + b, 0) / 12;
    const cross = sharpes.reduce((a, b) => a + (b - mean) ** 2, 0) / 11;
    const T = series[11].length;
    const V = Math.max(cross, 1 / (T - 1));
    const sr0 = Math.sqrt(V) * ((1 - GAMMA) * normalQuantile(1 - 1 / N) + GAMMA * normalQuantile(1 - 1 / (N * Math.E)));
    const sr = sharpes[cell];
    const g3 = sampleSkewness(series[11]);
    const g4 = sampleKurtosis(series[11]);
    return { V, cross, sr0, psr: normalCdf(((sr - sr0) * Math.sqrt(T - 1)) / Math.sqrt(1 - g3 * sr + ((g4 - 1) / 4) * sr * sr)) };
  }
  const make = (spread: number, seed: number) => {
    const random = createSeededRandom(seed);
    return Array.from({ length: 12 }, (_, c) => Array.from({ length: 800 }, () => (random() - 0.5) * 0.02 + 0.0004 + c * spread));
  };

  it('uses the cross-cell variance when it exceeds the floor, and equals the hand computation', () => {
    const series = make(0.0005, 3);
    const out = rvDsr(series);
    const want = hand(series, 672);
    expect(want.cross).toBeGreaterThan(1 / 799);
    expect(out.variance.used).toBe(want.cross);
    expect(out.gate.benchmark).toBeCloseTo(want.sr0, 12);
    expect(out.gate.probability).toBeCloseTo(want.psr, 12);
    expect(out.gate.N).toBe(672);
    expect(out.gate.pass).toBe(want.psr >= 0.95);
    expect(out.T).toBe(800);
    expect(out.observedSharpe).toBe(perPeriodSharpe(series[11]));
  });

  it('uses the floor 1 / (T - 1) when the cells barely differ', () => {
    // one shared series with tiny per-cell offsets: independent noise alone gives a cross variance near 1 / T
    const base = make(0, 4)[0];
    const series = Array.from({ length: 12 }, (_, c) => base.map((r) => r + c * 1e-5));
    const out = rvDsr(series);
    const want = hand(series, 672);
    expect(want.cross).toBeLessThan(1 / 799);
    expect(out.variance.used).toBe(1 / 799);
    expect(out.gate.probability).toBeCloseTo(want.psr, 12);
  });

  it('G3 deflates cell 11\'s Sharpe, not the best cell\'s', () => {
    // a small reversed spread: cell 11 trails, and neither probability saturates, so the two readings differ
    const series = make(-0.00002, 3);
    const sharpes = series.map((x) => perPeriodSharpe(x));
    const bestCell = sharpes.indexOf(Math.max(...sharpes));
    expect(bestCell).not.toBe(11);
    expect(Math.abs(hand(series, 672, bestCell).psr - hand(series, 672).psr)).toBeGreaterThan(0.01);
    const out = rvDsr(series);
    expect(out.observedSharpe).toBe(sharpes[11]);
    expect(out.gate.probability).toBeCloseTo(hand(series, 672).psr, 12);
    expect(out.reported.map((r) => r.probability)).toEqual([26, 2161].map((N) => expect.closeTo(hand(series, N).psr, 12)));
  });

  it('reports N = 26 and the program count 2,161, never gating on them', () => {
    expect(DSR_GATE_TRIALS).toBe(672);
    expect(DSR_REPORTED_TRIALS).toEqual([26, 2161]);
    const series = make(0.0003, 5);
    const out = rvDsr(series);
    expect(out.reported.map((r) => r.N)).toEqual([26, 2161]);
    for (const r of out.reported) expect(r.probability).toBeCloseTo(hand(series, r.N).psr, 12);
    expect(() => rvDsr(series.slice(1))).toThrow(/12/);
  });
});

// ------------------------------------------------------------------------------------------------ merge

/** A shard file as rv-stages writes it, with made-up statistics. */
function shardText(stage: ShardStage, name: string, mFrom: number, mTo: number, opts: { prov?: Provenance; M?: number; mutate?: (lines: NullLine[]) => void } = {}): string {
  const seedOf = stageSeed(stage);
  const lines: NullLine[] = [];
  for (let m = mFrom; m <= mTo; m++) {
    const best = Math.sin(m) * 0.01;
    lines.push(stage === 'wf-mcpt' ? { m, seed: seedOf(m), best, cells: [m % 12] } : { m, seed: seedOf(m), best, perCell: Array.from({ length: 12 }, (_, c) => best - c * 1e-4) });
  }
  opts.mutate?.(lines);
  const header = { kind: 'header', stage, name, mFrom, mTo, M: opts.M ?? 1000, provenance: opts.prov ?? PROV };
  return [header, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n';
}
const allShards = (stage: ShardStage) => shardJobs(stage).map((j) => ({ name: `${j.name}.jsonl`, text: shardText(stage, j.name, j.mFrom, j.mTo) }));

describe('mergeShards (judge merge: coverage, seeds, provenance)', () => {
  it('merges the 8 shards of a stage into M = 1,000 nulls in m order', () => {
    for (const stage of ['is-mcpt', 'wf-mcpt', 'block'] as const) {
      const merged = mergeShards(stage, allShards(stage).reverse(), PROV);
      expect(merged.M).toBe(1000);
      expect(merged.nulls).toHaveLength(1000);
      expect(merged.nulls[0]).toBe(Math.sin(1) * 0.01);
      expect(merged.nulls[999]).toBe(Math.sin(1000) * 0.01);
      expect(merged.provenance).toEqual(PROV);
    }
  });

  it('fails on a missing, extra or renamed shard', () => {
    const files = allShards('is-mcpt');
    expect(() => mergeShards('is-mcpt', files.slice(1), PROV)).toThrow(/missing[\s\S]*is-mcpt-01/);
    expect(() => mergeShards('is-mcpt', [...files, { name: 'stray.jsonl', text: files[0].text }], PROV)).toThrow(/stray/);
    expect(() => mergeShards('is-mcpt', [{ name: 'is-mcpt-01.jsonl', text: files[1].text }, ...files.slice(1)], PROV)).toThrow(/is-mcpt-01/);
    // right lines, wrong header: only the header check sees it
    const misnamed = [{ name: 'is-mcpt-01.jsonl', text: shardText('is-mcpt', 'is-mcpt-07', 1, 125) }, ...files.slice(1)];
    expect(() => mergeShards('is-mcpt', misnamed, PROV)).toThrow(/is-mcpt-01: its header names is-mcpt is-mcpt-07/);
  });

  it('fails on a missing or duplicated permutation, a wrong seed, or a wrong M', () => {
    const files = allShards('wf-mcpt');
    const edit = (i: number, mutate: (lines: NullLine[]) => void, M?: number) => {
      const j = shardJobs('wf-mcpt')[i];
      const copy = [...files];
      copy[i] = { name: `${j.name}.jsonl`, text: shardText('wf-mcpt', j.name, j.mFrom, j.mTo, { mutate, M }) };
      return copy;
    };
    expect(() => mergeShards('wf-mcpt', edit(2, (l) => l.pop()), PROV)).toThrow(/m = 375/);
    // a repeated line with every m still present: only the duplicate check sees it
    expect(() => mergeShards('wf-mcpt', edit(2, (l) => l.push({ ...l[3] })), PROV)).toThrow(/duplicate m = 254/);
    expect(() => mergeShards('wf-mcpt', edit(5, (l) => (l[0].seed += 1)), PROV)).toThrow(/seed/);
    expect(() => mergeShards('wf-mcpt', edit(5, (l) => (l[0].seed = RV_SEEDS.is(l[0].m))), PROV)).toThrow(/seed/);
    expect(() => mergeShards('wf-mcpt', edit(0, () => undefined, 999), PROV)).toThrow(/M/);
    expect(() => mergeShards('wf-mcpt', edit(1, (l) => (l[0].best = NaN)), PROV)).toThrow(/finite/);
  });

  it('fails on a shard run on another panel, dataset or commit', () => {
    for (const bad of [
      { ...PROV, panelSha256: '0'.repeat(64) },
      { ...PROV, manifestHash: '0'.repeat(64) },
      { ...PROV, gitCommit: 'b'.repeat(40) },
    ]) {
      const files = allShards('block');
      const j = shardJobs('block')[3];
      files[3] = { name: `${j.name}.jsonl`, text: shardText('block', j.name, j.mFrom, j.mTo, { prov: bad }) };
      expect(() => mergeShards('block', files, PROV)).toThrow(/provenance/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ verdict

describe('judgeVerdict (header VERDICT G1 to G3 and REPORTED)', () => {
  // Planted seed 72 is chosen so each gate's statistic differs from its alternative: the best in-sample cell is 7,
  // not 11, and the 1-bar purge selects cells 7, 7 where the walk-forward selects 5, 7, so the two objectives differ.
  let real: RealOutput;
  let loaded: LoadedInputs;
  let calOk: CalibrationEvidence;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-judge-'));
    const panel = syntheticPanel({ bars: 1700, symbols: 10, mode: 'planted', strength: 1, seed: 72 });
    const firstHour = { open: panel.open, high: panel.open.map((r) => r.map((o) => o * 1.002)), low: panel.open.map((r) => r.map((o) => o * 0.998)), close: panel.open };
    writeInputs(dir, { panel, firstHour, manifestHash: PROV.manifestHash, resolutions: { sha256: 'd'.repeat(64), entries: 0, flags: [] }, gitCommit: COMMIT, span: { from: 0, to: 1 } });
    loaded = loadInputs(dir, { manifestHash: PROV.manifestHash, gitCommit: COMMIT });
    real = runRealStage(loaded);
    rmSync(dir, { recursive: true, force: true });
    const outputs = fakeCalibration((kind, k) => (kind === 'planted' || kind === 'carry' ? 1 / 200 : uniformP(k, 99)));
    calOk = { record: JSON.parse(JSON.stringify(checkCalibration(outputs, COMMIT))), outputs };
  });
  const prov = () => real.provenance;
  const merged = (stage: ShardStage, nulls: number[]) => ({ stage, M: nulls.length, provenance: prov(), nulls });
  const below = Array(1000).fill(-1);
  /** 20 nulls halfway between two statistics: at or above exactly one of them. */
  const between = (a: number, b: number) => [...Array(980).fill(-1), ...Array(20).fill((a + b) / 2)];
  const pAt = (x: number, a: number, b: number) => (x <= (a + b) / 2 ? 21 / 1001 : 1 / 1001);

  it('the fixture separates every gate statistic from its alternative', () => {
    expect(calOk.record.pass).toBe(true);
    expect(real.step1.bestCell).toBe(7);
    expect(real.step1.objectives[11]).toBeLessThan(real.step1.best);
    expect(real.purge.objective).not.toBe(real.step3.objective);
    expect(real.purge.folds.map((f) => f.cell)).not.toEqual(real.step3.folds.map((f) => f.cell));
    expect(Math.max(...rvDsr(real.step1.returns).sharpes)).not.toBe(rvDsr(real.step1.returns).observedSharpe);
  });

  it('G1 and G2 are the step 2 and step 4 p-values below 0.01, G3 the deflated Sharpe of cell 11 at N = 672', () => {
    const wf = [...Array(980).fill(-1), ...Array(20).fill(real.step3.objective)];
    const v = judgeVerdict(real, { is: merged('is-mcpt', below), wf: merged('wf-mcpt', wf), block: merged('block', below) }, loaded, calOk);
    expect(v.gates.G1).toEqual({ p: 1 / 1001, threshold: 0.01, pass: true });
    expect(v.gates.G2).toEqual({ p: 21 / 1001, threshold: 0.01, pass: false });
    const dsr = rvDsr(real.step1.returns);
    expect(v.gates.G3).toEqual({ probability: dsr.gate.probability, threshold: 0.95, N: 672, pass: dsr.gate.probability >= 0.95 });
    expect(v.pass).toBe(false);
    expect(v.notes).toContain(FUNDING_MARK_NOTE);
    expect(v.notes).toContain(CARRY_ONLY_NOTE);
    expect(CARRY_ONLY_NOTE).toMatch(/0\.00205[\s\S]*far above real funding/);
    expect(v.provenance).toEqual(prov());
  });

  it('G1 tests the best in-sample cell\'s objective, not cell 11\'s', () => {
    const best = real.step1.best;
    const c11 = real.step1.objectives[11];
    const v = judgeVerdict(real, { is: merged('is-mcpt', between(best, c11)), wf: merged('wf-mcpt', below), block: merged('block', below) }, loaded, calOk);
    expect(v.gates.G1.p).toBe(pAt(best, best, c11));
    expect(v.gates.G1.p).not.toBe(pAt(c11, best, c11));
    expect(v.step1.bestCell).toBe(7);
  });

  it('G2 tests the stitched walk-forward objective, not the purge sensitivity\'s', () => {
    const wfObj = real.step3.objective;
    const purge = real.purge.objective;
    const v = judgeVerdict(real, { is: merged('is-mcpt', below), wf: merged('wf-mcpt', between(wfObj, purge)), block: merged('block', below) }, loaded, calOk);
    expect(v.gates.G2.p).toBe(pAt(wfObj, wfObj, purge));
    expect(v.gates.G2.p).not.toBe(pAt(purge, wfObj, purge));
    expect(v.reported.purge.objective).toBe(purge);
  });

  it('G1 and G2 never take each other\'s statistic', () => {
    const best = real.step1.best;
    const wfObj = real.step3.objective;
    expect(best).not.toBe(wfObj);
    const mid = between(best, wfObj);
    const v = judgeVerdict(real, { is: merged('is-mcpt', mid), wf: merged('wf-mcpt', mid), block: merged('block', mid) }, loaded, calOk);
    expect(v.gates.G1.p).toBe(pAt(best, best, wfObj));
    expect(v.gates.G2.p).toBe(pAt(wfObj, best, wfObj));
    expect(v.gates.G1.p).not.toBe(v.gates.G2.p);
    expect(v.reported.blockP).toBe(v.gates.G1.p);
  });

  it('passes only when all three gates pass, with ties counted against the rule', () => {
    const all = judgeVerdict(real, { is: merged('is-mcpt', below), wf: merged('wf-mcpt', below), block: merged('block', below) }, loaded, calOk);
    expect(all.pass).toBe(all.gates.G3.pass);
    const tie = judgeVerdict(real, { is: merged('is-mcpt', [...Array(990).fill(-1), ...Array(10).fill(real.step1.best)]), wf: merged('wf-mcpt', below), block: merged('block', below) }, loaded, calOk);
    expect(tie.gates.G1.p).toBe(11 / 1001);
    expect(tie.gates.G1.pass).toBe(false);
  });

  it('refuses inputs from another panel or commit, and a wrong M', () => {
    const ok = { is: merged('is-mcpt', below), wf: merged('wf-mcpt', below), block: merged('block', below) };
    expect(() => judgeVerdict(real, { ...ok, wf: { ...ok.wf, provenance: { ...prov(), gitCommit: 'b'.repeat(40) } } }, loaded, calOk)).toThrow(/provenance/);
    expect(() => judgeVerdict(real, ok, { ...loaded, provenance: { ...prov(), panelSha256: '0'.repeat(64) } }, calOk)).toThrow(/provenance/);
    expect(() => judgeVerdict(real, { ...ok, is: merged('is-mcpt', below.slice(1)) }, loaded, calOk)).toThrow(/M/);
  });

  it('refuses a real file the loaded panel does not reproduce, even one edited consistently (review m2)', () => {
    const ok = { is: merged('is-mcpt', below), wf: merged('wf-mcpt', below), block: merged('block', below) };
    const objective = structuredClone(real);
    objective.step1.objectives[3] += 0.01;
    expect(() => judgeVerdict(objective, ok, loaded, calOk)).toThrow(/REFUSE[\s\S]*step1\.objectives\[3\]/);
    // a series and its objective edited together: the old recompute-from-series check would pass this
    const series = structuredClone(real);
    series.step1.returns[3][10] += 1e-9;
    series.step1.objectives[3] = perPeriodSharpe(series.step1.returns[3]);
    expect(() => judgeVerdict(series, ok, loaded, calOk)).toThrow(/REFUSE[\s\S]*step1\.returns\[3\]\[10\]/);
    const purge = structuredClone(real);
    purge.purge.objective += 1e-9;
    expect(() => judgeVerdict(purge, ok, loaded, calOk)).toThrow(/REFUSE[\s\S]*purge\.objective/);
    const maker = structuredClone(real);
    maker.maker.returns[0] *= 1 + 1e-15;
    if (maker.maker.returns[0] !== real.maker.returns[0]) expect(() => judgeVerdict(maker, ok, loaded, calOk)).toThrow(/REFUSE[\s\S]*maker\.returns\[0\]/);
  });

  it('takes every figure from the recomputation: a lengthened series or an extra key is refused (review n1)', () => {
    const ok = { is: merged('is-mcpt', below), wf: merged('wf-mcpt', below), block: merged('block', below) };
    // three bars of +5% appended to cell 11: G3 would read them if it took the real file's series
    const padded = structuredClone(real);
    padded.step1.returns[11].push(0.05, 0.05, 0.05);
    expect(() => judgeVerdict(padded, ok, loaded, calOk)).toThrow(/REFUSE[\s\S]*step1\.returns\[11\] \(length 1657 against 1660\)/);
    expect(() => verifiedRealStage(padded, loaded)).toThrow(/REFUSE[\s\S]*length/);
    const extra = structuredClone(real) as RealOutput & { note?: string };
    extra.note = 'not produced by the real stage';
    expect(() => judgeVerdict(extra, ok, loaded, calOk)).toThrow(/REFUSE[\s\S]*note \(unexpected\)/);
    const nested = structuredClone(real);
    (nested.step3 as unknown as Record<string, unknown>).added = 1;
    expect(() => verifiedRealStage(nested, loaded)).toThrow(/REFUSE[\s\S]*step3\.added \(unexpected\)/);
    // the value judged is the recomputation itself
    expect(verifiedRealStage(real, loaded)).toEqual(JSON.parse(JSON.stringify(real)));
  });

  it('refuses unless the calibration outputs at this commit recompute to PASS and equal the record (review m3, n2)', () => {
    const ok = { is: merged('is-mcpt', below), wf: merged('wf-mcpt', below), block: merged('block', below) };
    expect(() => judgeVerdict(real, ok, loaded, calOk)).not.toThrow();
    const failOuts = fakeCalibration((kind, k) => (kind === 'planted' ? 0.5 : uniformP(k, 99)));
    const failed = { record: checkCalibration(failOuts, COMMIT), outputs: failOuts };
    expect(failed.record.pass).toBe(false);
    expect(() => judgeVerdict(real, ok, loaded, failed)).toThrow(/REFUSE[\s\S]*calibration[\s\S]*FAIL/);
    const otherOuts = calOk.outputs.map((o) => ({ ...o, gitCommit: 'b'.repeat(40) }));
    const other = { record: checkCalibration(otherOuts, 'b'.repeat(40)), outputs: otherOuts };
    expect(other.record.pass).toBe(true);
    expect(() => judgeVerdict(real, ok, loaded, other)).toThrow(/REFUSE[\s\S]*calibration[\s\S]*commit/);
    // the record must equal the recomputation from the outputs: a flipped flag either way, edited p-values
    expect(() => judgeVerdict(real, ok, loaded, { ...failed, record: { ...failed.record, pass: true } })).toThrow(/REFUSE[\s\S]*calibration record[\s\S]*pass/);
    expect(() => judgeVerdict(real, ok, loaded, { ...calOk, record: { ...calOk.record, pass: false } })).toThrow(/REFUSE[\s\S]*calibration record[\s\S]*pass/);
    const edited = structuredClone(calOk.record);
    edited.universes[3].isP = 0.5;
    edited.iid.is.ps[3] = 0.5;
    expect(() => judgeVerdict(real, ok, loaded, { ...calOk, record: edited })).toThrow(/REFUSE[\s\S]*calibration record[\s\S]*universes\[3\]\.isP/);
    // a passing record over failing outputs is refused, and so is a missing output
    expect(() => judgeVerdict(real, ok, loaded, { record: calOk.record, outputs: failOuts })).toThrow(/REFUSE[\s\S]*calibration/);
    expect(() => judgeVerdict(real, ok, loaded, { ...calOk, outputs: calOk.outputs.slice(1) })).toThrow(/REFUSE[\s\S]*cal-iid-001/);
  });

  it('reports every item the inputs allow', () => {
    const v = judgeVerdict(real, { is: merged('is-mcpt', below), wf: merged('wf-mcpt', below), block: merged('block', [...Array(999).fill(-1), real.step1.best]) }, loaded, calOk);
    const r = v.reported;
    expect(r.blockP).toBe(2 / 1001);
    expect(r.neighbours).toHaveLength(12);
    expect(r.neighbours[11]).toMatchObject({ cell: 11, buffer: 2, betaNeutral: true, flowOn: true, perBar: real.step1.objectives[11] });
    expect(r.folds.map((f) => f.cell)).toEqual(real.step3.folds.map((f) => f.cell));
    expect(r.distinctFoldCells).toBe(new Set(real.step3.folds.map((f) => f.cell)).size);
    expect(r.rvV1).toEqual(seriesStats(real.rvV1.returns, real.t, real.firstStep, real.rvV1.detail));
    expect(r.walkForward).toEqual(seriesStats(real.step3.returns, real.t, real.step3.firstStep, real.step3.detail));
    expect(r.maker.makerFills).toBe(real.maker.detail.makerFills);
    expect(r.stress.annualised).toBeCloseTo(perPeriodSharpe(real.stress.returns) * Math.sqrt(1095.75), 12);
    expect(r.purge.objective).toBe(real.purge.objective);
    expect(r.dsrReported.map((x) => x.N)).toEqual([26, 2161]);
    expect(r.deskFillQuality).toMatch(/forward desk/);
    expect(v.calibration).toEqual({ gitCommit: COMMIT, pass: true });
  });
});

describe('seriesStats (REPORTED: gross, profit factor, drawdown, turnover, per year, the 2026-07-01 slice, funding share)', () => {
  it('computes each figure from the per-bar series', () => {
    const t0 = Date.UTC(2025, 11, 31, 0);
    const t = Array.from({ length: 10 }, (_, i) => t0 + i * 8 * 3_600_000);
    const returns = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02];
    const detail = {
      funding: [0.002, 0.001, 0.0, 0.001, 0.0, 0.003],
      price: [0.009, -0.02, 0.031, 0.01, -0.009, 0.018],
      cost: [0.001, 0.001, 0.001, 0.001, 0.001, 0.001],
      turnover: [0.5, 0.1, 0.1, 0.1, 0.1, 0.1],
    };
    const s = seriesStats(returns, t, 2, detail);
    expect(s.n).toBe(6);
    expect(s.total).toBeCloseTo(1.01 * 0.98 * 1.03 * 1.01 * 0.99 * 1.02 - 1, 12);
    expect(s.annualised).toBeCloseTo(perPeriodSharpe(returns) * Math.sqrt(1095.75), 12);
    expect(s.profitFactor).toBeCloseTo((0.01 + 0.03 + 0.01 + 0.02) / (0.02 + 0.01), 12);
    expect(s.maxDrawdown).toBeCloseTo(0.02, 12);
    expect(s.grossAnnualised).toBeCloseTo(perPeriodSharpe(returns.map((r, i) => r + detail.cost[i])) * Math.sqrt(1095.75), 12);
    expect(s.funding).toBeCloseTo(0.007, 12);
    expect(s.cost).toBeCloseTo(0.006, 12);
    expect(s.fundingShare).toBeCloseTo(0.007 / 0.04, 12);
    expect(s.annualTurnover).toBeCloseTo((1.0 / 6) * 1095.75, 9);
    // step 2 starts at t[2] = 2025-12-31 16:00, so one bar in 2025 and five in 2026
    expect(s.perYear.map((y) => [y.year, y.n])).toEqual([
      [2025, 1],
      [2026, 5],
    ]);
    expect(s.perYear[0].total).toBeCloseTo(0.01, 12);
    expect(s.since20260701).toMatchObject({ n: 0 });
  });

  it('slices from 2026-07-01 00:00 UTC', () => {
    const t0 = Date.UTC(2026, 5, 30, 8);
    const t = Array.from({ length: 8 }, (_, i) => t0 + i * 8 * 3_600_000);
    const s = seriesStats([0.01, 0.02, -0.01, 0.005, 0.01, 0.0], t, 0, null);
    expect(s.since20260701.n).toBe(4);
    expect(s.since20260701.total).toBeCloseTo(0.99 * 1.005 * 1.01 * 1.0 - 1, 12);
    expect(s.funding).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ calibration acceptance

/** Calibration outputs at the header scale with made-up statistics: real at quantile q of the nulls. */
function fakeCalibration(pOf: (kind: string, k: number, step: 'is' | 'wf') => number): CalibrationOutput[] {
  return calibrationJobs().map(({ kind, k }) => {
    const spec = CALIBRATION_UNIVERSES[kind];
    const seed = spec.seed(k);
    const nulls = (step: 'is' | 'wf') => {
      // a target p of (1 + a) / (M + 1): a nulls at or above the real 0, the rest below
      const above = Math.round(pOf(kind, k, step) * (spec.M + 1)) - 1;
      return Array.from({ length: spec.M }, (_, i) => ({ m: i + 1, seed: RV_SEEDS.inner(seed, i + 1), best: i < above ? 1 : -1 }));
    };
    return {
      stage: 'calibrate' as const,
      kind,
      k,
      seed,
      bars: 3000,
      geometry: RV_WF_GEOMETRY,
      M: spec.M,
      gitCommit: COMMIT,
      is: { real: 0, perCell: Array(12).fill(0), nulls: nulls('is') },
      wf: { real: 0, cells: [0], nulls: nulls('wf') },
      timing: { prepareMs: 100, oneCellMs: 20, twelveCellsMs: 300, isPermutationMs: 320, wfPermutationMs: 400 },
    };
  });
}
const uniformP = (k: number, M: number) => Math.ceil(((k - 0.5) / 100) * (M + 1)) / (M + 1);

describe('checkCalibration (header CALIBRATION ACCEPTANCE)', () => {
  it('passes when the driftless p-values are uniform and the planted edge is found', () => {
    const outs = fakeCalibration((kind, k) => (kind === 'iid' || kind === 'garch' ? uniformP(k, 99) : 1 / 200));
    const c = checkCalibration(outs, COMMIT);
    expect(c.iid.is.ks.p).toBeGreaterThan(0.01);
    expect(c.iid.is.share05).toBeLessThanOrEqual(0.11);
    expect(c.planted).toMatchObject({ isAt01: 10, wfAt01: 10, pass: true });
    expect(c.pass).toBe(true);
    expect(c.timing.isPermutationMs).toBe(320);
    expect(c.carry.note).toBe(CARRY_ONLY_NOTE);
  });

  it('planted acceptance counts p = 2/200 = 0.01 as found (p <= 0.01, header CALIBRATION)', () => {
    // one null at or above the real statistic on every seed gives p = 2/200 exactly
    const outs = fakeCalibration((kind, k, step) => (kind === 'planted' ? (step === 'is' ? (k <= 9 ? 2 / 200 : 0.5) : k <= 8 ? 2 / 200 : 0.5) : uniformP(k, 99)));
    const c = checkCalibration(outs, COMMIT);
    expect(c.planted.isPs.filter((p) => p === 0.01)).toHaveLength(9);
    expect(c.planted.wfPs.filter((p) => p === 0.01)).toHaveLength(8);
    expect(c.planted).toMatchObject({ isAt01: 9, wfAt01: 8, pass: true });
    expect(c.pass).toBe(true);
    expect(c.gitCommit).toBe(COMMIT);
  });

  it('fails an anti-conservative driftless test: too many p <= 0.05', () => {
    const outs = fakeCalibration((kind, k, step) => (kind === 'iid' && step === 'wf' ? (k <= 15 ? 0.05 : uniformP(k, 99)) : kind === 'planted' ? 1 / 200 : uniformP(k, 99)));
    const c = checkCalibration(outs, COMMIT);
    expect(c.iid.wf.share05).toBeGreaterThan(0.11);
    expect(c.iid.pass).toBe(false);
    expect(c.pass).toBe(false);
  });

  it('allows at most 11 of 100 driftless p-values at or below 0.05: 11 passes, 12 fails', () => {
    // p = 0.05 on the first `bad` seeds, the rest spread evenly over (0.05, 1]
    const spread = (bad: number) => (kind: string, k: number) =>
      kind === 'planted' ? 1 / 200 : kind === 'iid' && k <= bad ? 0.05 : Math.ceil((0.05 + ((k - bad) / (100 - bad)) * 0.95) * 100) / 100;
    const eleven = checkCalibration(fakeCalibration(spread(11)), COMMIT);
    expect(eleven.iid.is.share05).toBe(0.11);
    expect(eleven.iid.is.ks.p).toBeGreaterThan(0.01);
    expect(eleven.iid.is.pass).toBe(true);
    const twelve = checkCalibration(fakeCalibration(spread(12)), COMMIT);
    expect(twelve.iid.is.share05).toBe(0.12);
    expect(twelve.iid.is.pass).toBe(false);
  });

  it('fails a KS p at or below 0.01 and a planted edge found on too few seeds', () => {
    const skewed = checkCalibration(
      fakeCalibration((kind, k) => (kind === 'iid' ? Math.min(1, 0.3 + k / 150) : 1 / 200)),
      COMMIT
    );
    expect(skewed.iid.is.ks.p).toBeLessThanOrEqual(0.01);
    expect(skewed.pass).toBe(false);
    const weak = checkCalibration(fakeCalibration((kind, k, step) => (kind === 'planted' ? (step === 'is' ? (k <= 8 ? 1 / 200 : 0.5) : k <= 8 ? 1 / 200 : 0.5) : uniformP(k, 99))), COMMIT);
    expect(weak.planted).toMatchObject({ isAt01: 8, wfAt01: 8, pass: false });
    const enough = checkCalibration(fakeCalibration((kind, k, step) => (kind === 'planted' ? (step === 'is' ? (k <= 9 ? 1 / 200 : 0.5) : k <= 8 ? 1 / 200 : 0.5) : uniformP(k, 99))), COMMIT);
    expect(enough.planted).toMatchObject({ isAt01: 9, wfAt01: 8, pass: true });
  });

  it('refuses an incomplete set, a wrong seed, a wrong scale, or another commit', () => {
    const outs = fakeCalibration((kind, k) => uniformP(k, 99));
    expect(() => checkCalibration(outs.slice(1), COMMIT)).toThrow(/cal-iid-001/);
    expect(() => checkCalibration(outs, 'b'.repeat(40))).toThrow(/commit/);
    const seed = structuredClone(outs);
    seed[5].is.nulls[3].seed += 1;
    expect(() => checkCalibration(seed, COMMIT)).toThrow(/seed/);
    const scale = structuredClone(outs);
    scale[104].M = 99;
    expect(() => checkCalibration(scale, COMMIT)).toThrow(/M/);
    const bars = structuredClone(outs);
    bars[0].bars = 2000;
    expect(() => checkCalibration(bars, COMMIT)).toThrow(/bars/);
  });
});

describe('jobLines (judge jobs: what the 7C runner reads)', () => {
  it('prints one line per job: name stage mFrom mTo, or name kind k for calibration', () => {
    expect(jobLines('is-mcpt')).toEqual(shardJobs('is-mcpt').map((j) => `${j.name} ${j.stage} ${j.mFrom} ${j.mTo}`));
    expect(jobLines('calibrate')[0]).toBe('cal-iid-001 iid 1');
    expect(jobLines('calibrate')).toHaveLength(130);
    expect(() => jobLines('nope' as 'block')).toThrow(/stage/);
  });
});
