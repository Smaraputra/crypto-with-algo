// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { QH_FLOW_HOLDOUT } from './qh-flow';
import { NULL_REPORT_KIND, QH_FLOW_FACTORS, QH_FLOW_HORIZONS, type NullReport } from './qh-flow-null';
import {
  assertVerdictInputs,
  computeVerdict,
  parseVerdictArgs,
  type VerdictInputs,
} from './qh-flow-verdict';
import type { FactorIcReport } from './report-schema';

const HASH = 'a'.repeat(64);
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT'];
const QUARTERS = ['2024Q4', '2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2'];
const END = { '1h': '2026-06-30T23:00:00Z', '4h': '2026-06-30T20:00:00Z' } as const;

type Cell = { ic: number; t: number };
type Cells = Partial<Record<string, Record<number, Cell>>>;

const QUIET: Cell = { ic: 0.001, t: 0.5 };
/** A cell strong enough for the rule when the sign matches the prediction. */
const strong = (sign: 1 | -1): Cell => ({ ic: 0.03 * sign, t: 6 * sign });

function stat(horizon: number, c: Cell) {
  return {
    horizon,
    n: 10_000,
    ic: c.ic,
    icT: c.t,
    nNonOverlapping: 1000,
    icNonOverlapping: c.ic,
    signHitRate: 0.5,
    bootstrapCi95: null,
    quantileSpread: { top: 0, bottom: 0, spread: 0 },
  };
}

function report(interval: '1h' | '4h', cells: Cells, over: Partial<FactorIcReport> = {}): FactorIcReport {
  const horizons = [...QH_FLOW_HORIZONS[interval]];
  return {
    schemaVersion: 1,
    taskId: `holdout-${interval}`,
    datasetManifestHash: HASH,
    lockboxApplied: true,
    interval,
    symbols: SYMBOLS,
    horizons,
    executionLagBars: 1,
    returnSeries: 'perp',
    dateRange: { startMs: Date.parse(QH_FLOW_HOLDOUT.start), endMs: Date.parse(END[interval]) },
    computedAt: '2026-10-10T00:00:00Z',
    gitCommit: 'test',
    bootstrap: { iterations: 200, seed: 42, perSymbol: false, gateAbsT: 2, maxPairs: 100_000 },
    factors: QH_FLOW_FACTORS.map((name) => {
      const perH = (h: number): Cell => cells[name]?.[h] ?? QUIET;
      return {
        name,
        category: 'raw',
        perSymbol: SYMBOLS.map((symbol) => ({ symbol, horizons: horizons.map((h) => stat(h, perH(h))) })),
        pooled: { horizons: horizons.map((h) => stat(h, perH(h))) },
        rollingQuarterly: horizons.flatMap((h) =>
          QUARTERS.map((quarter) => ({ quarter, horizon: h, ic: perH(h).ic, n: 500, t: perH(h).t }))
        ),
      };
    }),
    skippedFactors: [],
    ...over,
  };
}

function floor(interval: '1h' | '4h', level = 0.01, over: Partial<NullReport['args']> = {}): NullReport {
  const horizons = [...QH_FLOW_HORIZONS[interval]];
  return {
    reportKind: NULL_REPORT_KIND,
    args: {
      interval,
      datasetDir: 'd',
      start: Date.parse(QH_FLOW_HOLDOUT.start),
      end: Date.parse(QH_FLOW_HOLDOUT.end),
      horizons,
      factors: [...QH_FLOW_FACTORS],
      executionLagBars: 1,
      returnSeries: 'perp',
      draws: 200,
      seed: 7,
      minShiftDays: 30,
      nullOnly: true,
      out: 'o',
      ...over,
    },
    datasetManifestHash: HASH,
    commit: 'test',
    symbols: SYMBOLS,
    barCounts: [],
    grid: { bars: 0, firstT: 0, lastT: 0, perSymbol: [] },
    minShiftBars: 720,
    offsets: [],
    cells: QH_FLOW_FACTORS.flatMap((factor) =>
      horizons.map((horizon) => ({
        factor,
        horizon,
        nullMeanIc: 0,
        nullSdIc: level / 3.15,
        nullP95AbsT: 2,
        detectionFloorIc: level,
        validDraws: 200,
      }))
    ),
  };
}

function inputs(
  c1h: Cells = {},
  c4h: Cells = {},
  floorLevel = 0.01
): VerdictInputs {
  return {
    reports: { '1h': report('1h', c1h), '4h': report('4h', c4h) },
    floors: { '1h': floor('1h', floorLevel), '4h': floor('4h', floorLevel) },
  };
}

describe('computeVerdict', () => {
  it('is NULL when nothing clears the rule (kill criterion 2)', () => {
    const v = computeVerdict(inputs());
    expect(v.verdict).toBe('NULL');
    expect(v.killCriterion2.triggered).toBe(true);
    expect(v.killCriterion1.triggered).toBe(false);
    expect(v.pooledCells).toBe(28);
    expect(v.columns['raw.qhOpenImb'].byInterval['1h'].survives).toBe(false);
    expect(v.columns['raw.qhOpenImb'].byInterval['1h'].reasons.join(' ')).toMatch(/only 0 horizon/);
  });

  it('is SURVIVOR when a predicted column passes at two counted horizons with the predicted sign', () => {
    const v = computeVerdict(inputs({ 'raw.qhOpenImb': { 4: strong(1), 8: strong(1) } }));
    expect(v.verdict).toBe('SURVIVOR');
    expect(v.columns['raw.qhOpenImb'].survivesAnywhere).toBe(true);
    expect(v.columns['raw.qhOpenImb'].byInterval['1h']).toMatchObject({ survives: true, horizonsPassing: [4, 8] });
    expect(v.columns['raw.qhOpenImb'].byInterval['4h'].survives).toBe(false);
  });

  it('counts only the predicted sign (A1-3): smallTakerImb positive does not survive, negative does', () => {
    const wrong = computeVerdict(inputs({ 'raw.smallTakerImb': { 4: strong(1), 8: strong(1) } }));
    expect(wrong.verdict).toBe('NULL');
    const wrongReasons = wrong.columns['raw.smallTakerImb'].byInterval['1h'].reasons.join(' ');
    expect(wrongReasons).toMatch(/not the predicted -/);

    const right = computeVerdict(inputs({ 'raw.smallTakerImb': { 4: strong(-1), 8: strong(-1) } }));
    expect(right.verdict).toBe('SURVIVOR');
  });

  it('never counts raw.qhOpenImb at 1h h1 (A1-3)', () => {
    const twoWithH1 = computeVerdict(inputs({ 'raw.qhOpenImb': { 1: strong(1), 4: strong(1) } }));
    expect(twoWithH1.verdict).toBe('NULL');
    expect(twoWithH1.columns['raw.qhOpenImb'].byInterval['1h'].reasons.join(' ')).toMatch(/no prediction at 1h h1/);

    const threeWithH1 = computeVerdict(inputs({ 'raw.qhOpenImb': { 1: strong(1), 4: strong(1), 8: strong(1) } }));
    expect(threeWithH1.columns['raw.qhOpenImb'].byInterval['1h'].horizonsPassing).toEqual([4, 8]);
    expect(threeWithH1.verdict).toBe('SURVIVOR');
  });

  it('applies the detection floor per cell (A1-2)', () => {
    // |ic| 0.03 against a floor of 0.05: the unchanged rule passes, the floor does not.
    const v = computeVerdict(inputs({ 'raw.largeTakerImb': { 4: strong(1), 8: strong(1) } }, {}, 0.05));
    expect(v.verdict).toBe('NULL');
    expect(v.columns['raw.largeTakerImb'].byInterval['1h'].reasons.join(' ')).toMatch(/below the detection floor 0\.05000/);

    const base = inputs({ 'raw.largeTakerImb': { 4: strong(1), 8: strong(1) } });
    // Floor raised on h8 only: one counted horizon is left, so the two-horizon leg fails.
    base.floors['1h'].cells.find((c) => c.factor === 'raw.largeTakerImb' && c.horizon === 8)!.detectionFloorIc = 0.05;
    expect(computeVerdict(base).verdict).toBe('NULL');
  });

  it('fails when any counted horizon is below the floor (A1-2 strict rule)', () => {
    // h4, h8, h12 all pass with the predicted sign, but h12 is below its floor.
    // Under the old code, h12 would be excluded and the column would survive with h4, h8.
    // Under the strict rule, the column fails.
    const base = inputs(
      { 'raw.qhOpenImb': { 4: strong(1), 8: strong(1), 12: strong(1) } },
      {},
      0.01
    );
    base.floors['1h'].cells.find((c) => c.factor === 'raw.qhOpenImb' && c.horizon === 12)!.detectionFloorIc = 0.05;
    const v = computeVerdict(base);
    expect(v.verdict).toBe('NULL');
    expect(v.columns['raw.qhOpenImb'].byInterval['1h'].survives).toBe(false);
    const reasons = v.columns['raw.qhOpenImb'].byInterval['1h'].reasons.join(' ');
    expect(reasons).toMatch(/h12.*below the detection floor 0\.05000/);
  });

  it('survives when all counted horizons clear the floor (A1-2 strict rule)', () => {
    // h4, h8, h12 all pass with the predicted sign and all clear the floor.
    const v = computeVerdict(inputs({ 'raw.qhOpenImb': { 4: strong(1), 8: strong(1), 12: strong(1) } }));
    expect(v.verdict).toBe('SURVIVOR');
    expect(v.columns['raw.qhOpenImb'].byInterval['1h'].survives).toBe(true);
    expect(v.columns['raw.qhOpenImb'].byInterval['1h'].horizonsPassing).toEqual([4, 8, 12]);
  });

  it('fails a predicted column whose quarters disagree with the sign', () => {
    const data = inputs({ 'raw.largeTakerImb': { 4: strong(1), 8: strong(1) } });
    for (const q of data.reports['1h'].factors.find((f) => f.name === 'raw.largeTakerImb')!.rollingQuarterly) {
      q.ic = -Math.abs(q.ic);
    }
    const v = computeVerdict(data);
    expect(v.verdict).toBe('NULL');
    expect(v.columns['raw.largeTakerImb'].byInterval['1h'].reasons.join(' ')).toMatch(/quarter agreement/);
  });

  it('is SUSPECT when the negative control survives in either sign (kill criterion 1), even beside a survivor', () => {
    for (const sign of [1, -1] as const) {
      const v = computeVerdict(
        inputs({ 'raw.fiveMinOpenImb': { 4: strong(sign), 8: strong(sign) }, 'raw.qhOpenImb': { 4: strong(1), 8: strong(1) } })
      );
      expect(v.verdict).toBe('SUSPECT');
      expect(v.killCriterion1.triggered).toBe(true);
      expect(v.killCriterion2.triggered).toBe(false);
      expect(v.columns['raw.fiveMinOpenImb'].byInterval['1h'].survives).toBe(true);
    }
  });

  it('reads the 4h report too', () => {
    const v = computeVerdict(inputs({}, { 'raw.qhOpenImb': { 1: strong(1), 2: strong(1) } }));
    expect(v.verdict).toBe('SURVIVOR');
    expect(v.columns['raw.qhOpenImb'].byInterval['4h'].horizonsPassing).toEqual([1, 2]);
  });

  it('records the diagnostics of every horizon', () => {
    const v = computeVerdict(inputs({ 'raw.qhOpenImb': { 4: strong(1) } }));
    const h4 = v.columns['raw.qhOpenImb'].byInterval['1h'].horizons.find((h) => h.horizon === 4)!;
    expect(h4).toMatchObject({ clearsRule: true, fdrRejected: true, excluded: null });
  });
});

describe('assertVerdictInputs', () => {
  const ok = () => inputs();
  const rejects = (mutate: (i: VerdictInputs) => void, message: RegExp) => {
    const i = ok();
    mutate(i);
    expect(() => assertVerdictInputs(i)).toThrow(message);
    expect(() => computeVerdict(i)).toThrow(message);
  };

  it('accepts the locked family', () => {
    expect(() => assertVerdictInputs(ok())).not.toThrow();
  });

  it('refuses mixed dataset hashes, in a report or a floor', () => {
    rejects((i) => (i.reports['4h'].datasetManifestHash = 'b'.repeat(64)), /manifest hashes/);
    rejects((i) => (i.floors['1h'].datasetManifestHash = 'b'.repeat(64)), /manifest hashes/);
  });

  it('refuses lag other than 1 and non-perp returns', () => {
    rejects((i) => (i.reports['1h'].executionLagBars = 0), /execution lag/);
    rejects((i) => delete i.reports['4h'].returnSeries, /need perp/);
    rejects((i) => (i.floors['4h'].args.executionLagBars = 0), /execution lag/);
    rejects((i) => (i.floors['1h'].args.returnSeries = 'spot'), /need perp/);
  });

  it('refuses a window that is not the locked hold-out', () => {
    rejects((i) => (i.reports['1h'].dateRange.startMs = Date.parse('2023-01-01T00:00:00Z')), /hold-out/);
    rejects((i) => (i.reports['1h'].dateRange.endMs = Date.parse('2026-07-01T00:00:00Z')), /hold-out/);
    rejects((i) => (i.reports['4h'].dateRange.endMs = Date.parse('2026-06-01T00:00:00Z')), /hold-out/);
    rejects((i) => (i.floors['1h'].args.start = Date.parse('2024-11-02T00:00:00Z')), /hold-out/);
  });

  it('refuses a widened or narrowed factor set', () => {
    rejects((i) => i.reports['1h'].factors.push({ ...i.reports['1h'].factors[0], name: 'raw.rsi' }), /four qh-flow columns/);
    rejects((i) => i.reports['1h'].factors.pop(), /four qh-flow columns/);
    rejects((i) => i.floors['4h'].args.factors.pop(), /four columns/);
  });

  it('refuses other horizons or a missing pooled cell', () => {
    rejects((i) => (i.reports['1h'].horizons = [1, 2, 4, 8]), /horizons/);
    rejects((i) => i.reports['4h'].factors[2].pooled.horizons.pop(), /pooled horizons/);
    rejects((i) => (i.floors['1h'].args.horizons = [1, 4]), /horizons/);
  });

  it('refuses a floor that is not a null-only report or lacks a cell', () => {
    rejects((i) => (i.floors['1h'].args.nullOnly = false), /null-only/);
    rejects((i) => ((i.floors['1h'] as { reportKind: string }).reportKind = 'other'), /qh-flow-null/);
    rejects((i) => i.floors['4h'].cells.pop(), /detection floor/);
    rejects((i) => (i.floors['4h'].cells[0].detectionFloorIc = NaN), /detection floor/);
  });

  it('requires floor reports to have draws 200', () => {
    rejects((i) => (i.floors['1h'].args.draws = 100), /draws is 100, need 200/);
    rejects((i) => (i.floors['4h'].args.draws = 300), /draws is 300, need 200/);
  });

  it('requires floor reports to have seed 7', () => {
    rejects((i) => (i.floors['1h'].args.seed = 42), /seed is 42, need 7/);
    rejects((i) => (i.floors['4h'].args.seed = 1), /seed is 1, need 7/);
  });

  it('requires floor reports to have minShiftDays 30', () => {
    rejects((i) => (i.floors['1h'].args.minShiftDays = 20), /minShiftDays is 20, need 30/);
    rejects((i) => (i.floors['4h'].args.minShiftDays = 60), /minShiftDays is 60, need 30/);
  });

  it('refuses a swapped interval and a different bootstrap', () => {
    rejects((i) => (i.reports['1h'].interval = '4h'), /interval/);
    rejects((i) => (i.reports['1h'].bootstrap.seed = 1), /bootstrap/);
  });
});

describe('parseVerdictArgs', () => {
  it('needs all four inputs and rejects unknown flags', () => {
    expect(
      parseVerdictArgs(['--report-1h', 'a', '--report-4h', 'b', '--floor-1h', 'c', '--floor-4h', 'd', '--out', 'v.json'])
    ).toEqual({ report1h: 'a', report4h: 'b', floor1h: 'c', floor4h: 'd', out: 'v.json' });
    expect(() => parseVerdictArgs(['--report-1h', 'a'])).toThrow(/--report-4h/);
    expect(() => parseVerdictArgs(['--nope', 'x'])).toThrow(/Unknown flag/);
  });
});
