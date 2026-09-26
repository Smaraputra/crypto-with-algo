// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SURVIVOR_RULE,
  checkFindings,
  checkReportConsistency,
  checkStrategyFindings,
  evaluatePhaseSurvivors,
  evaluateSurvivors,
  spotCheckCell,
  spotCheckStrategyWindow,
  validateFactorIcReport,
  validateStrategyReport,
  validateSubagentReport,
  type FactorIcReport,
  type FactorReport,
  type HorizonStat,
  type StrategyReport,
  type SubagentReport,
} from './report-schema';

function makeHorizonStat(overrides: Partial<HorizonStat> = {}): HorizonStat {
  return {
    horizon: 1,
    n: 400,
    ic: 0.03,
    icT: 3,
    nNonOverlapping: 100,
    icNonOverlapping: 0.03,
    signHitRate: 0.53,
    bootstrapCi95: [0.01, 0.05],
    quantileSpread: { top: 0.02, bottom: -0.01, spread: 0.03 },
    ...overrides,
  };
}

function makeFactorReport(overrides: Partial<FactorReport> = {}): FactorReport {
  return {
    name: 'raw.ret1',
    category: 'raw',
    perSymbol: [
      { symbol: 'BTCUSDT', horizons: [makeHorizonStat()] },
      { symbol: 'ETHUSDT', horizons: [makeHorizonStat()] },
    ],
    pooled: { horizons: [makeHorizonStat()] },
    rollingQuarterly: [{ quarter: '2025Q1', horizon: 1, ic: 0.04, n: 50, t: 2.1 }],
    ...overrides,
  };
}

function makeFactorIcReport(factors: FactorReport[]): FactorIcReport {
  return {
    schemaVersion: 1,
    taskId: 'factor-ic-1h-test',
    datasetManifestHash: 'abc123',
    lockboxApplied: true,
    interval: '1h',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    horizons: [1, 2, 4],
    dateRange: { startMs: 0, endMs: 1_000_000 },
    computedAt: '2026-09-17T00:00:00.000Z',
    gitCommit: 'deadbeef',
    bootstrap: { iterations: 200, seed: 42, perSymbol: false, gateAbsT: 2, maxPairs: 100_000 },
    factors,
    skippedFactors: [],
  };
}

function makeSubagentReport(overrides: Partial<SubagentReport> = {}): SubagentReport {
  return {
    schemaVersion: 1,
    taskId: 'factor-ic-1h-test',
    agentModel: 'claude-sonnet-5',
    datasetManifestHash: 'abc123',
    lockboxApplied: true,
    scope: { kind: 'interval', value: '1h' },
    subjects: ['raw.ret1'],
    reportFiles: ['data/research/reports/factor-ic-1h-test.json'],
    topFindings: [],
    caveats: [],
    reproCommand: 'npx tsx scripts/research/factor-ic.ts --interval 1h',
    gitCommit: 'deadbeef',
    durationMs: 1234,
    ...overrides,
  };
}

describe('validateFactorIcReport', () => {
  it('accepts a well-formed document', () => {
    const report = makeFactorIcReport([makeFactorReport()]);
    const result = validateFactorIcReport(report);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.factors).toHaveLength(1);
    }
  });

  it('accepts skippedFactors entries and the bootstrap gateAbsT/maxPairs fields', () => {
    const report = {
      ...makeFactorIcReport([makeFactorReport()]),
      skippedFactors: [{ name: 'raw.fundingRate', category: 'raw', reason: 'no finite pairs at any horizon' }],
    };
    const result = validateFactorIcReport(report);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skippedFactors).toEqual([
        { name: 'raw.fundingRate', category: 'raw', reason: 'no finite pairs at any horizon' },
      ]);
      expect(result.data.bootstrap).toEqual({ iterations: 200, seed: 42, perSymbol: false, gateAbsT: 2, maxPairs: 100_000 });
    }
  });

  it('rejects a document missing skippedFactors', () => {
    const report = makeFactorIcReport([makeFactorReport()]) as unknown as Record<string, unknown>;
    delete report.skippedFactors;
    const result = validateFactorIcReport(report);
    expect(result.ok).toBe(false);
  });

  it('rejects a document missing a required field', () => {
    const report = makeFactorIcReport([makeFactorReport()]) as unknown as Record<string, unknown>;
    delete report.datasetManifestHash;

    const result = validateFactorIcReport(report);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.includes('datasetManifestHash'))).toBe(true);
    }
  });

  it('rejects a document with the wrong schemaVersion', () => {
    const report = { ...makeFactorIcReport([makeFactorReport()]), schemaVersion: 2 };
    const result = validateFactorIcReport(report);
    expect(result.ok).toBe(false);
  });

  it('rejects a horizon stat with a non-numeric ic', () => {
    const bad = makeFactorReport({ pooled: { horizons: [makeHorizonStat({ ic: 'oops' as unknown as number })] } });
    const result = validateFactorIcReport(makeFactorIcReport([bad]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes('ic'))).toBe(true);
    }
  });
});

describe('validateSubagentReport', () => {
  it('accepts a well-formed document', () => {
    const result = validateSubagentReport(makeSubagentReport());
    expect(result.ok).toBe(true);
  });

  it('accepts topFindings without factor/horizon/symbol (all optional)', () => {
    const result = validateSubagentReport(
      makeSubagentReport({
        topFindings: [{ claim: 'BTC funding rate mildly bearish', metric: 'mean', value: -0.0001, n: 100 }],
      })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid scope.kind', () => {
    const bad = { ...makeSubagentReport(), scope: { kind: 'bogus', value: '1h' } };
    const result = validateSubagentReport(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes('scope'))).toBe(true);
    }
  });

  it('rejects a non-array caveats field', () => {
    const bad = { ...makeSubagentReport(), caveats: 'none' };
    const result = validateSubagentReport(bad);
    expect(result.ok).toBe(false);
  });
});

describe('SURVIVOR_RULE', () => {
  it('matches the values fixed by the brief', () => {
    expect(SURVIVOR_RULE).toEqual({
      minAbsIc: 0.02,
      minT: 3.15,
      minHorizons: 2,
      minQuarterAgreement: 0.6,
      minSymbolAgreement: 0.7,
    });
  });
});

describe('evaluateSurvivors', () => {
  it('marks a factor a survivor when horizons, quarters, and symbols all agree', () => {
    const factor = makeFactorReport({
      name: 'raw.ret1',
      pooled: {
        horizons: [
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.3 }),
          makeHorizonStat({ horizon: 2, ic: 0.04, icT: 3.2 }),
          makeHorizonStat({ horizon: 4, ic: 0.01, icT: 1.0 }),
        ],
      },
      rollingQuarterly: [
        { quarter: '2025Q1', horizon: 1, ic: 0.06, n: 40, t: 2.5 },
        { quarter: '2025Q2', horizon: 1, ic: 0.05, n: 40, t: 2.2 },
        { quarter: '2025Q3', horizon: 1, ic: 0.03, n: 40, t: 1.8 },
        { quarter: '2025Q4', horizon: 2, ic: 0.04, n: 40, t: 2.1 },
        { quarter: '2026Q1', horizon: 2, ic: -0.01, n: 40, t: -0.4 },
      ],
      perSymbol: [
        {
          symbol: 'BTCUSDT',
          horizons: [
            makeHorizonStat({ horizon: 1, ic: 0.06, icT: 3.1 }),
            makeHorizonStat({ horizon: 2, ic: 0.05, icT: 2.9 }),
          ],
        },
        {
          symbol: 'ETHUSDT',
          horizons: [
            makeHorizonStat({ horizon: 1, ic: 0.03, icT: 2.6 }),
            makeHorizonStat({ horizon: 2, ic: 0.04, icT: 2.7 }),
          ],
        },
      ],
    });

    const [row] = evaluateSurvivors(makeFactorIcReport([factor]));

    expect(row.factor).toBe('raw.ret1');
    expect(row.interval).toBe('1h');
    expect(row.horizonsPassing).toEqual([1, 2]);
    expect(row.sign).toBe(1);
    expect(row.quarterAgreement).toBeCloseTo(4 / 5, 12);
    expect(row.symbolAgreement).toBe(1);
    expect(row.survivor).toBe(true);
    expect(row.reasons).toEqual([]);
  });

  it('fails on quarter agreement when most quarters disagree in sign', () => {
    const factor = makeFactorReport({
      pooled: {
        horizons: [
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.3 }),
          makeHorizonStat({ horizon: 2, ic: 0.04, icT: 3.2 }),
        ],
      },
      rollingQuarterly: [
        { quarter: '2025Q1', horizon: 1, ic: 0.06, n: 40, t: 2.5 },
        { quarter: '2025Q2', horizon: 1, ic: -0.05, n: 40, t: -2.0 },
        { quarter: '2025Q3', horizon: 2, ic: -0.03, n: 40, t: -1.8 },
        { quarter: '2025Q4', horizon: 2, ic: -0.04, n: 40, t: -2.1 },
        { quarter: '2026Q1', horizon: 2, ic: -0.02, n: 40, t: -1.0 },
      ],
      perSymbol: [
        {
          symbol: 'BTCUSDT',
          horizons: [
            makeHorizonStat({ horizon: 1, ic: 0.06, icT: 3.1 }),
            makeHorizonStat({ horizon: 2, ic: 0.05, icT: 2.9 }),
          ],
        },
        {
          symbol: 'ETHUSDT',
          horizons: [
            makeHorizonStat({ horizon: 1, ic: 0.03, icT: 2.6 }),
            makeHorizonStat({ horizon: 2, ic: 0.04, icT: 2.7 }),
          ],
        },
      ],
    });

    const [row] = evaluateSurvivors(makeFactorIcReport([factor]));

    expect(row.horizonsPassing).toEqual([1, 2]);
    expect(row.symbolAgreement).toBe(1);
    expect(row.quarterAgreement).toBeLessThan(SURVIVOR_RULE.minQuarterAgreement);
    expect(row.survivor).toBe(false);
    expect(row.reasons).toHaveLength(1);
    expect(row.reasons[0]).toMatch(/quarter agreement/);
  });

  it('fails on symbol agreement when most symbols disagree in sign', () => {
    const factor = makeFactorReport({
      pooled: {
        horizons: [
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.3 }),
          makeHorizonStat({ horizon: 2, ic: 0.04, icT: 3.2 }),
        ],
      },
      rollingQuarterly: [
        { quarter: '2025Q1', horizon: 1, ic: 0.06, n: 40, t: 2.5 },
        { quarter: '2025Q2', horizon: 1, ic: 0.05, n: 40, t: 2.2 },
        { quarter: '2025Q3', horizon: 2, ic: 0.03, n: 40, t: 1.8 },
      ],
      perSymbol: [
        {
          symbol: 'BTCUSDT',
          horizons: [
            makeHorizonStat({ horizon: 1, ic: 0.06, icT: 3.1 }),
            makeHorizonStat({ horizon: 2, ic: 0.05, icT: 2.9 }),
          ],
        },
        {
          symbol: 'ETHUSDT',
          horizons: [
            makeHorizonStat({ horizon: 1, ic: -0.03, icT: -2.6 }),
            makeHorizonStat({ horizon: 2, ic: -0.04, icT: -2.7 }),
          ],
        },
        {
          symbol: 'SOLUSDT',
          horizons: [
            makeHorizonStat({ horizon: 1, ic: -0.03, icT: -2.6 }),
            makeHorizonStat({ horizon: 2, ic: -0.04, icT: -2.7 }),
          ],
        },
      ],
    });

    const [row] = evaluateSurvivors(makeFactorIcReport([factor]));

    expect(row.horizonsPassing).toEqual([1, 2]);
    expect(row.symbolAgreement).toBeCloseTo(1 / 3, 12);
    expect(row.symbolAgreement).toBeLessThan(SURVIVOR_RULE.minSymbolAgreement);
    expect(row.survivor).toBe(false);
    expect(row.reasons).toHaveLength(1);
    expect(row.reasons[0]).toMatch(/symbol agreement/);
  });

  it('fails on horizon count when fewer than minHorizons pass', () => {
    const factor = makeFactorReport({
      pooled: {
        horizons: [
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.3 }),
          makeHorizonStat({ horizon: 2, ic: 0.005, icT: 0.8 }),
          makeHorizonStat({ horizon: 4, ic: 0.01, icT: 1.2 }),
        ],
      },
      rollingQuarterly: [
        { quarter: '2025Q1', horizon: 1, ic: 0.06, n: 40, t: 2.5 },
        { quarter: '2025Q2', horizon: 1, ic: 0.05, n: 40, t: 2.2 },
      ],
      perSymbol: [
        { symbol: 'BTCUSDT', horizons: [makeHorizonStat({ horizon: 1, ic: 0.06, icT: 3.1 })] },
        { symbol: 'ETHUSDT', horizons: [makeHorizonStat({ horizon: 1, ic: 0.03, icT: 2.6 })] },
      ],
    });

    const [row] = evaluateSurvivors(makeFactorIcReport([factor]));

    expect(row.horizonsPassing).toEqual([1]);
    expect(row.survivor).toBe(false);
    expect(row.reasons).toHaveLength(1);
    expect(row.reasons[0]).toMatch(/horizon/);
  });

  it('reports sign 0 and every reason when nothing passes', () => {
    const factor = makeFactorReport({
      pooled: { horizons: [makeHorizonStat({ horizon: 1, ic: 0.001, icT: 0.2 })] },
      rollingQuarterly: [],
      perSymbol: [],
    });

    const [row] = evaluateSurvivors(makeFactorIcReport([factor]));

    expect(row.horizonsPassing).toEqual([]);
    expect(row.sign).toBe(0);
    expect(row.quarterAgreement).toBe(0);
    expect(row.symbolAgreement).toBe(0);
    expect(row.survivor).toBe(false);
    expect(row.reasons).toHaveLength(3);
  });
});

function horizonStat(horizon: number, ic: number, icT: number): HorizonStat {
  return {
    horizon,
    n: 1000,
    ic,
    icT,
    nNonOverlapping: 100,
    icNonOverlapping: ic,
    signHitRate: 0.55,
    bootstrapCi95: null,
    quantileSpread: { top: ic, bottom: -ic, spread: 2 * ic },
  };
}

/** A factor that passes the rule on its own: two horizons above |ic| 0.02 and |t| 3.15, all quarters and symbols agreeing. */
function survivingFactor(name: string, icT: number): FactorReport {
  const horizons = [horizonStat(1, 0.03, icT), horizonStat(2, 0.03, icT)];
  return {
    name,
    category: 'raw',
    perSymbol: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol) => ({ symbol, horizons })),
    pooled: { horizons },
    rollingQuarterly: ['2024Q1', '2024Q2', '2024Q3'].flatMap((quarter) =>
      horizons.map((h) => ({ quarter, horizon: h.horizon, ic: 0.03, n: 100, t: 3 }))
    ),
  };
}

function nullFactor(name: string): FactorReport {
  const horizons = [horizonStat(1, 0.001, 0.5), horizonStat(2, 0.001, 0.5)];
  return { name, category: 'raw', perSymbol: [], pooled: { horizons }, rollingQuarterly: [] };
}

function icReport(taskId: string, interval: string, factors: FactorReport[]): FactorIcReport {
  return {
    schemaVersion: 1,
    taskId,
    datasetManifestHash: 'abc',
    lockboxApplied: true,
    interval,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    horizons: [1, 2],
    executionLagBars: 1,
    dateRange: { startMs: 0, endMs: 1 },
    computedAt: 'now',
    gitCommit: 'test',
    bootstrap: { iterations: 200, seed: 42, perSymbol: false, gateAbsT: 2, maxPairs: 100000 },
    factors,
    skippedFactors: [],
  };
}

describe('evaluateSurvivors with an FDR predicate', () => {
  it('drops a horizon the predicate excludes and records it', () => {
    const report = icReport('t', '1h', [survivingFactor('raw.a', 4)]);
    const rows = evaluateSurvivors(report, (_name, horizon) => horizon !== 2);
    expect(rows[0].survivor).toBe(false);
    expect(rows[0].horizonsPassing).toEqual([1]);
    expect(rows[0].fdrExcludedHorizons).toEqual([2]);
  });

  it('is unchanged when no predicate is given', () => {
    const report = icReport('t', '1h', [survivingFactor('raw.a', 4)]);
    expect(evaluateSurvivors(report)[0].survivor).toBe(true);
    expect(evaluateSurvivors(report)[0].fdrExcludedHorizons).toBeUndefined();
  });
});

describe('evaluatePhaseSurvivors', () => {
  it('lets a strong factor through a small phase and records the rule and cell count', () => {
    const table = evaluatePhaseSurvivors([icReport('a', '1h', [survivingFactor('raw.a', 4), nullFactor('raw.b')])], 0.1);
    expect(table.minT).toBe(3.15);
    expect(table.fdrQ).toBe(0.1);
    expect(table.cells).toBe(4);
    expect(table.perInterval).toEqual([{ interval: '1h', taskId: 'a', survivors: 1, factors: 2 }]);
    expect(table.rows.find((r) => r.factor === 'raw.a')?.survivor).toBe(true);
  });

  it('fails a factor at |t| 3.2 once 198 null cells share the phase', () => {
    // t 3.2 is p 0.00137. With m 200 the k 2 threshold is 0.001, so neither
    // of the two passing horizons is rejected by the FDR: the factor clears
    // the |t| rule alone and fails the phase.
    const nulls = Array.from({ length: 99 }, (_, i) => nullFactor(`raw.null${i}`));
    const table = evaluatePhaseSurvivors([icReport('a', '1h', [survivingFactor('raw.a', 3.2), ...nulls])], 0.1);
    expect(table.cells).toBe(200);
    const row = table.rows.find((r) => r.factor === 'raw.a')!;
    expect(row.survivor).toBe(false);
    expect(row.fdrExcludedHorizons).toEqual([1, 2]);
    expect(table.rejectedCells).toBe(0);
  });

  it('keys cells by taskId so two reports on the same interval do not collide', () => {
    const a = icReport('a', '1h', [survivingFactor('raw.a', 4)]);
    const b = icReport('b', '1h', [survivingFactor('raw.a', 4)]);
    const table = evaluatePhaseSurvivors([a, b], 0.1);
    expect(table.cells).toBe(4);
    expect(table.perInterval.map((p) => p.taskId)).toEqual(['a', 'b']);
  });
});

describe('checkFindings', () => {
  const factor = makeFactorReport({
    name: 'raw.ret1',
    category: 'raw',
    pooled: {
      horizons: [
        makeHorizonStat({
          horizon: 1,
          ic: 0.055,
          icT: 3.4,
          n: 500,
          nNonOverlapping: 120,
          icNonOverlapping: 0.06,
          signHitRate: 0.54,
          bootstrapCi95: [0.02, 0.09],
          quantileSpread: { top: 0.03, bottom: -0.02, spread: 0.05 },
        }),
      ],
    },
    perSymbol: [
      {
        symbol: 'BTCUSDT',
        horizons: [makeHorizonStat({ horizon: 1, ic: 0.07, icT: 3.6, n: 250 })],
      },
    ],
    rollingQuarterly: [{ quarter: '2025Q1', horizon: 1, ic: 0.08, n: 60, t: 2.9 }],
  });
  const report = makeFactorIcReport([factor]);

  it('grounds a finding whose value matches a pooled HorizonStat field', () => {
    const sub = makeSubagentReport({
      topFindings: [{ claim: 'ret1 predicts h1', metric: 'ic', value: 0.055, n: 500, factor: 'raw.ret1', horizon: 1 }],
    });
    expect(checkFindings(sub, report)).toEqual([]);
  });

  it('grounds a finding whose value matches a rolling-quarterly entry (pooled scope)', () => {
    const sub = makeSubagentReport({
      topFindings: [{ claim: 'Q1 was strong', metric: 'ic', value: 0.08, n: 60, factor: 'raw.ret1', horizon: 1 }],
    });
    expect(checkFindings(sub, report)).toEqual([]);
  });

  it('grounds a finding whose value matches a per-symbol HorizonStat field', () => {
    const sub = makeSubagentReport({
      topFindings: [
        { claim: 'BTC ret1 strong', metric: 'ic', value: 0.07, n: 250, factor: 'raw.ret1', horizon: 1, symbol: 'BTCUSDT' },
      ],
    });
    expect(checkFindings(sub, report)).toEqual([]);
  });

  it('flags a finding whose value appears nowhere in the report', () => {
    const sub = makeSubagentReport({
      topFindings: [{ claim: 'made up', metric: 'ic', value: 0.9999, n: 500, factor: 'raw.ret1', horizon: 1 }],
    });
    const ungrounded = checkFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(0);
  });

  it('flags a finding that names a factor absent from the report', () => {
    const sub = makeSubagentReport({
      topFindings: [{ claim: 'bogus', metric: 'ic', value: 0.055, n: 500, factor: 'sig.NoSuchSignal', horizon: 1 }],
    });
    const ungrounded = checkFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].reason).toMatch(/not found/);
  });

  it('flags a finding with no factor to ground against', () => {
    const sub = makeSubagentReport({
      topFindings: [{ claim: 'vague claim', metric: 'ic', value: 0.055, n: 500 }],
    });
    const ungrounded = checkFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(0);
  });

  it('checks each finding independently by index', () => {
    const sub = makeSubagentReport({
      topFindings: [
        { claim: 'good', metric: 'ic', value: 0.055, n: 500, factor: 'raw.ret1', horizon: 1 },
        { claim: 'bad', metric: 'ic', value: 12.34, n: 500, factor: 'raw.ret1', horizon: 1 },
      ],
    });
    const ungrounded = checkFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(1);
  });

  it('does not ground a value that only coincidentally matches the horizon number', () => {
    // value 1 matches the HorizonStat's horizon (1), not any statistic --
    // horizon and n are deliberately excluded from the groundable numbers.
    const sub = makeSubagentReport({
      topFindings: [{ claim: 'bogus, matches only the horizon', metric: 'ic', value: 1, n: 500, factor: 'raw.ret1', horizon: 1 }],
    });
    const ungrounded = checkFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(0);
  });

  it('does not ground a value that only coincidentally matches a sample size (n)', () => {
    // value 500 matches the pooled HorizonStat's n, not any statistic.
    const sub = makeSubagentReport({
      topFindings: [{ claim: 'bogus, matches only n', metric: 'ic', value: 500, n: 500, factor: 'raw.ret1', horizon: 1 }],
    });
    const ungrounded = checkFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(0);
  });
});

describe('spotCheckCell', () => {
  const factor = makeFactorReport({
    name: 'raw.ret1',
    pooled: { horizons: [makeHorizonStat({ horizon: 1, ic: 0.05, n: 500 })] },
    perSymbol: [{ symbol: 'BTCUSDT', horizons: [makeHorizonStat({ horizon: 1, ic: 0.07, n: 250 })] }],
  });
  const report = makeFactorIcReport([factor]);

  it('passes when the recomputed cell is close and n matches', () => {
    const result = spotCheckCell(report, { factor: 'raw.ret1', horizon: 1, symbol: 'BTCUSDT' }, { ic: 0.075, n: 250 });
    expect(result.ok).toBe(true);
    expect(result.nMatches).toBe(true);
    expect(result.deltaIc).toBeCloseTo(0.005, 12);
  });

  it('fails when the recomputed ic drifts beyond the tolerance', () => {
    const result = spotCheckCell(report, { factor: 'raw.ret1', horizon: 1, symbol: 'BTCUSDT' }, { ic: 0.2, n: 250 });
    expect(result.ok).toBe(false);
    expect(result.nMatches).toBe(true);
  });

  it('fails when n does not match even if ic is close', () => {
    const result = spotCheckCell(report, { factor: 'raw.ret1', horizon: 1, symbol: 'BTCUSDT' }, { ic: 0.07, n: 249 });
    expect(result.ok).toBe(false);
    expect(result.nMatches).toBe(false);
  });

  it('checks the pooled cell when symbol is omitted', () => {
    const result = spotCheckCell(report, { factor: 'raw.ret1', horizon: 1 }, { ic: 0.05, n: 500 });
    expect(result.ok).toBe(true);
  });

  it('fails cleanly when the cell does not exist in the report', () => {
    const result = spotCheckCell(report, { factor: 'raw.ret1', horizon: 999, symbol: 'BTCUSDT' }, { ic: 0.07, n: 250 });
    expect(result.ok).toBe(false);
  });
});

describe('checkReportConsistency', () => {
  const factorReport = makeFactorIcReport([makeFactorReport()]);

  it('passes when datasetManifestHash and lockboxApplied agree', () => {
    const sub = makeSubagentReport({
      datasetManifestHash: factorReport.datasetManifestHash,
      lockboxApplied: factorReport.lockboxApplied,
    });
    expect(checkReportConsistency(sub, factorReport)).toEqual({ ok: true, issues: [] });
  });

  it('fails when datasetManifestHash differs', () => {
    const sub = makeSubagentReport({
      datasetManifestHash: 'a-different-hash',
      lockboxApplied: factorReport.lockboxApplied,
    });
    const result = checkReportConsistency(sub, factorReport);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatch(/datasetManifestHash/);
  });

  it('fails when lockboxApplied differs', () => {
    const sub = makeSubagentReport({
      datasetManifestHash: factorReport.datasetManifestHash,
      lockboxApplied: !factorReport.lockboxApplied,
    });
    const result = checkReportConsistency(sub, factorReport);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatch(/lockboxApplied/);
  });

  it('reports both issues when both fields differ', () => {
    const sub = makeSubagentReport({
      datasetManifestHash: 'a-different-hash',
      lockboxApplied: !factorReport.lockboxApplied,
    });
    const result = checkReportConsistency(sub, factorReport);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Strategy report additions
// ---------------------------------------------------------------------------

function makeStrategyWindow(overrides: Partial<StrategyReport['perSymbol'][number]['windows'][number]> = {}) {
  return {
    index: 0,
    trainStart: 0,
    trainEnd: 199,
    testStart: 210,
    testEnd: 259,
    selectedParams: { threshold: 5 },
    skippedReason: null,
    isCells: [
      {
        params: { threshold: 5 },
        trades: 20,
        expectancyPercent: 1.2,
        expectancyR: 0.6,
        perTradeSharpe: 0.3,
        winRate: 0.55,
        profitFactor: 1.4,
        maxDrawdownPercent: 3.2,
      },
    ],
    oosCells: [{ params: { threshold: 5 }, trades: 15, expectancyPercent: 0.9 }],
    oos: {
      trades: 15,
      expectancyPercent: 0.9,
      expectancyR: 0.45,
      winRate: 0.53,
      profitFactor: 1.3,
      maxDrawdownPercent: 2.1,
      medianHoldBars: 5,
      fees: 3,
      slippageCost: 0.5,
      fundingCost: 0,
      snapshotCoveragePercent: 95,
    },
    stress: { trades: 15, expectancyPercent: 0.4 },
    benchmark: {
      iterations: 100,
      seed: 1,
      meanRandom: -0.1,
      sdRandom: 0.8,
      pValue: 0.02,
      referenceTrades: 15,
    },
    ...overrides,
  };
}

function makeStrategyPerSymbol(
  symbol: string,
  overrides: Partial<StrategyReport['perSymbol'][number]> = {}
): StrategyReport['perSymbol'][number] {
  return {
    symbol,
    snapshotRows: 500,
    htfBars: 300,
    windowConfig: {
      trainBars: 800,
      testWindowBars: 200,
      purgeGapBars: 30,
      stepSizeBars: 200,
      mode: 'anchored',
      count: 3,
    },
    benchmarkSeed: 1,
    windows: [makeStrategyWindow()],
    pooledOos: { trades: 15, expectancyPercent: 0.9, winRate: 0.53 },
    ...overrides,
  };
}

function makePooledStats(overrides: Partial<StrategyReport['pooled']> = {}): StrategyReport['pooled'] {
  return {
    n: 150,
    expectancyPercent: 0.8,
    expectancyR: 0.4,
    winRate: 0.54,
    profitFactor: 1.5,
    avgWinPercent: 1.9,
    avgLossPercent: 1.1,
    payoffRatio: 1.9 / 1.1,
    medianHoldBars: 5,
    maxDrawdownPercent: 4,
    bootstrapCi95: [0.2, 1.4],
    bootstrap: { iterations: 1000, seed: 42, meanBlockLen: 5 },
    windowsTotal: 30,
    windowsPositive: 22,
    windowPositiveShare: 0.733,
    symbolsTotal: 10,
    symbolsPositive: 8,
    symbolPositiveShare: 0.8,
    benchmarkWindows: 25,
    randomEntryP: 0.01,
    trials: 1,
    deflatedSharpe: {
      observedSharpe: 0.4,
      benchmarkSharpe: 0.05,
      probability: 0.97,
      radicand: 0.8,
      varianceOfTrialSharpes: 0,
    },
    plateau: { score: 0.7, neighbors: 2, bestMetric: 1.2, bestParams: { threshold: 5 }, neighborRadius: 0.5 },
    stressTrades: 100,
    stressExpectancyPercent: 0.4,
    perYear: [{ year: 2025, trades: 150, expectancyPercent: 0.8 }],
    ...overrides,
  };
}

function makeStrategyGates(overrides: Partial<StrategyReport['gates'][number]>[] = []): StrategyReport['gates'] {
  const defaults: StrategyReport['gates'] = [
    { name: 'sample', pass: true, value: 150, threshold: 100 },
    { name: 'expectancy', pass: true, value: 0.2, threshold: 0, note: 'point estimate 0.8' },
    { name: 'windows', pass: true, value: 0.733, threshold: 0.6 },
    { name: 'symbols', pass: true, value: 0.8, threshold: 0.7 },
    { name: 'timing', pass: true, value: 0.01, threshold: 0.05 },
    { name: 'trials', pass: true, value: 0.97, threshold: 0.95 },
    { name: 'plateau', pass: true, value: 0.7, threshold: 0.6 },
    { name: 'stress', pass: true, value: 0.4, threshold: 0 },
  ];
  return defaults.map((gate, i) => ({ ...gate, ...overrides[i] }));
}

function makeStrategyReport(overrides: Partial<StrategyReport> = {}): StrategyReport {
  return {
    schemaVersion: 1,
    taskId: 'strategy-control-1h-test',
    datasetManifestHash: 'abc123',
    lockboxApplied: true,
    family: 'control',
    style: 'day_trading',
    interval: '1h',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    dateRange: { startMs: 0, endMs: 1_000_000 },
    gridCells: 1,
    trials: 1,
    snapshotSource: '1h',
    costs: { feePercent: 0.0005, makerFeePercent: 0.0002, takerFeePercent: 0.0005, slippageBps: 3, fundingEnabled: true },
    windowConfig: { mode: 'anchored', trainFraction: 0.4, count: 3, minIsTrades: 10 },
    stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
    benchmark: { enabled: true, iterations: 100, seed: 1 },
    bootstrap: { iterations: 1000, seed: 42, meanBlockLen: 5 },
    perSymbol: [makeStrategyPerSymbol('BTCUSDT'), makeStrategyPerSymbol('ETHUSDT')],
    pooled: makePooledStats(),
    gates: makeStrategyGates(),
    pass: true,
    computedAt: '2026-09-17T00:00:00.000Z',
    gitCommit: 'deadbeef',
    durationMs: 5000,
    ...overrides,
  };
}

function makeStrategySubagentReport(overrides: Partial<SubagentReport> = {}): SubagentReport {
  return {
    schemaVersion: 1,
    taskId: 'strategy-control-1h-test',
    agentModel: 'claude-sonnet-5',
    datasetManifestHash: 'abc123',
    lockboxApplied: true,
    scope: { kind: 'strategy', value: 'control' },
    subjects: ['control'],
    reportFiles: ['data/research/reports/strategy-control-1h-test.json'],
    topFindings: [],
    caveats: [],
    reproCommand: 'npx tsx scripts/research/strategy-harness.ts --family control --interval 1h',
    gitCommit: 'deadbeef',
    durationMs: 1234,
    ...overrides,
  };
}

describe('validateStrategyReport', () => {
  it('accepts a well-formed strategy report', () => {
    const result = validateStrategyReport(makeStrategyReport());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.gates).toHaveLength(8);
      expect(result.data.gates.map((g) => g.name)).toEqual([
        'sample',
        'expectancy',
        'windows',
        'symbols',
        'timing',
        'trials',
        'plateau',
        'stress',
      ]);
    }
  });

  it('rejects a report missing gates', () => {
    const report = makeStrategyReport() as unknown as Record<string, unknown>;
    delete report.gates;
    const result = validateStrategyReport(report);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes('gates'))).toBe(true);
    }
  });

  it('rejects a report with a NaN-bearing field with a readable issue', () => {
    const report = {
      ...makeStrategyReport(),
      pooled: { ...makeStrategyReport().pooled, expectancyPercent: NaN },
    };
    const result = validateStrategyReport(report);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.includes('pooled.expectancyPercent'))).toBe(true);
    }
  });

  it('rejects a report with the wrong schemaVersion', () => {
    const result = validateStrategyReport({ ...makeStrategyReport(), schemaVersion: 2 });
    expect(result.ok).toBe(false);
  });

  it('accepts a null pooled.deflatedSharpe and pooled.plateau', () => {
    const report = makeStrategyReport({
      pooled: makePooledStats({ deflatedSharpe: null, plateau: null }),
    });
    const result = validateStrategyReport(report);
    expect(result.ok).toBe(true);
  });
});

describe('checkStrategyFindings', () => {
  it('grounds a pooled finding (no symbol) against a pooled.* value', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'positive expectancy', metric: 'expectancyPercent', value: 0.8, n: 150 }],
    });
    expect(checkStrategyFindings(sub, report)).toEqual([]);
  });

  it('grounds a pooled finding against a gate value', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'deflated sharpe probability', metric: 'trials gate', value: 0.97, n: 150 }],
    });
    expect(checkStrategyFindings(sub, report)).toEqual([]);
  });

  it('grounds a pooled finding against perYear[].expectancyPercent specifically', () => {
    // expectancyPercent set to a value that appears ONLY in perYear, not in
    // pooled.expectancyPercent itself, to isolate what is being grounded.
    const report = makeStrategyReport({
      pooled: makePooledStats({
        expectancyPercent: 1.5,
        perYear: [{ year: 2025, trades: 150, expectancyPercent: 0.6234 }],
      }),
    });
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: '2025 expectancy', metric: 'expectancyPercent', value: 0.6234, n: 150 }],
    });
    expect(checkStrategyFindings(sub, report)).toEqual([]);
  });

  it('does not ground a pooled finding against an excluded count field (n)', () => {
    // The sample gate's value is normally pooled.n itself (150), which would
    // ground the same number through gates[].value regardless of pooled's
    // own exclusion; override it here so this test isolates pooled.n's
    // exclusion specifically.
    const report = makeStrategyReport({ gates: makeStrategyGates([{ value: 999 }]) });
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'bogus, matches only n', metric: 'sample size', value: 150, n: 150 }],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(0);
  });

  it('does not ground a pooled finding against an excluded perYear[].year/trades field', () => {
    const report = makeStrategyReport({ gates: makeStrategyGates([{ value: 999 }]) });
    const sub = makeStrategySubagentReport({
      topFindings: [
        { claim: 'bogus, matches only perYear.year', metric: 'year', value: 2025, n: 150 },
        { claim: 'bogus, matches only perYear.trades', metric: 'trades', value: 150, n: 150 },
      ],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    // Both should fail (2025 and 150 do not otherwise appear in pooled/gates).
    expect(ungrounded.map((u) => u.index)).toEqual([0, 1]);
  });

  it('does not ground a pooled finding against a plateau.bestParams value', () => {
    // 777 appears only as a grid cell's own parameter value, not as any
    // statistic; the dynamic key name (here "threshold") must not defeat
    // the exclusion.
    const report = makeStrategyReport({
      gates: makeStrategyGates([{ value: 999 }]),
      pooled: makePooledStats({
        plateau: { score: 0.7, neighbors: 2, bestMetric: 1.2, bestParams: { threshold: 777 }, neighborRadius: 1 },
      }),
    });
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'bogus, matches only bestParams.threshold', metric: 'threshold', value: 777, n: 150 }],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(0);
  });

  it('flags an ungrounded pooled finding', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'made up', metric: 'expectancyPercent', value: 999.999, n: 150 }],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].reason).toMatch(/not found in pooled report/);
  });

  it('grounds a per-symbol finding against pooledOos.expectancyPercent/winRate', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [
        { claim: 'BTC oos expectancy', metric: 'expectancyPercent', value: 0.9, n: 15, symbol: 'BTCUSDT' },
        { claim: 'BTC oos win rate', metric: 'winRate', value: 0.53, n: 15, symbol: 'BTCUSDT' },
      ],
    });
    expect(checkStrategyFindings(sub, report)).toEqual([]);
  });

  it('flags a per-symbol finding for an unknown symbol', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'bogus symbol', metric: 'expectancyPercent', value: 0.9, n: 15, symbol: 'DOGEUSDT' }],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].reason).toMatch(/symbol "DOGEUSDT" not found/);
  });

  it('flags a per-symbol finding whose value is not in that symbol table', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'bogus value', metric: 'expectancyPercent', value: 42, n: 15, symbol: 'BTCUSDT' }],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
  });

  it('grounds a per-window finding against oos numbers and benchmark.pValue', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [
        { claim: 'window 0 expectancy', metric: 'expectancyPercent', value: 0.9, n: 15, symbol: 'BTCUSDT', window: 0 },
        { claim: 'window 0 benchmark p', metric: 'pValue', value: 0.02, n: 15, symbol: 'BTCUSDT', window: 0 },
      ],
    });
    expect(checkStrategyFindings(sub, report)).toEqual([]);
  });

  it('flags a per-window finding for an unknown window index', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'bogus window', metric: 'expectancyPercent', value: 0.9, n: 15, symbol: 'BTCUSDT', window: 99 }],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].reason).toMatch(/window 99 not found/);
  });

  it('flags a per-window finding whose value is not in that window table', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [{ claim: 'bogus window value', metric: 'expectancyPercent', value: 12.5, n: 15, symbol: 'BTCUSDT', window: 0 }],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
  });

  it('checks each finding independently by index', () => {
    const report = makeStrategyReport();
    const sub = makeStrategySubagentReport({
      topFindings: [
        { claim: 'good', metric: 'expectancyPercent', value: 0.8, n: 150 },
        { claim: 'bad', metric: 'expectancyPercent', value: 123.456, n: 150 },
      ],
    });
    const ungrounded = checkStrategyFindings(sub, report);
    expect(ungrounded).toHaveLength(1);
    expect(ungrounded[0].index).toBe(1);
  });
});

describe('spotCheckStrategyWindow', () => {
  const report = makeStrategyReport();

  it('passes when trades match exactly and expectancy is within tolerance', () => {
    const result = spotCheckStrategyWindow(
      report,
      { symbol: 'BTCUSDT', window: 0 },
      { trades: 15, expectancyPercent: 0.9 + 1e-10 }
    );
    expect(result.ok).toBe(true);
    expect(result.tradesMatch).toBe(true);
    expect(result.deltaExpectancy).toBeCloseTo(1e-10, 15);
  });

  it('fails when trades do not match', () => {
    const result = spotCheckStrategyWindow(report, { symbol: 'BTCUSDT', window: 0 }, { trades: 14, expectancyPercent: 0.9 });
    expect(result.ok).toBe(false);
    expect(result.tradesMatch).toBe(false);
  });

  it('fails when expectancy drifts beyond tolerance', () => {
    const result = spotCheckStrategyWindow(report, { symbol: 'BTCUSDT', window: 0 }, { trades: 15, expectancyPercent: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.tradesMatch).toBe(true);
  });

  it('treats two nulls as a matching expectancy', () => {
    const skippedReport = makeStrategyReport({
      perSymbol: [
        makeStrategyPerSymbol('BTCUSDT', {
          windows: [
            makeStrategyWindow({
              selectedParams: { threshold: 5 },
              oos: { trades: 0, expectancyPercent: null, expectancyR: null, winRate: null, profitFactor: null, maxDrawdownPercent: null, medianHoldBars: null, fees: 0, slippageCost: 0, fundingCost: 0, snapshotCoveragePercent: null },
            }),
          ],
        }),
      ],
    });
    const result = spotCheckStrategyWindow(skippedReport, { symbol: 'BTCUSDT', window: 0 }, { trades: 0, expectancyPercent: null });
    expect(result.ok).toBe(true);
    expect(result.deltaExpectancy).toBe(0);
  });

  it('returns ok false with a NaN delta for a missing symbol', () => {
    const result = spotCheckStrategyWindow(report, { symbol: 'DOGEUSDT', window: 0 }, { trades: 15, expectancyPercent: 0.9 });
    expect(result.ok).toBe(false);
    expect(Number.isNaN(result.deltaExpectancy)).toBe(true);
  });

  it('returns ok false with a NaN delta for a missing window', () => {
    const result = spotCheckStrategyWindow(report, { symbol: 'BTCUSDT', window: 99 }, { trades: 15, expectancyPercent: 0.9 });
    expect(result.ok).toBe(false);
    expect(Number.isNaN(result.deltaExpectancy)).toBe(true);
  });

  it('returns ok false with a NaN delta for a skipped window (oos null)', () => {
    const skippedReport = makeStrategyReport({
      perSymbol: [
        makeStrategyPerSymbol('BTCUSDT', {
          windows: [makeStrategyWindow({ selectedParams: null, skippedReason: 'no cell reached minIsTrades', oos: null })],
        }),
      ],
    });
    const result = spotCheckStrategyWindow(skippedReport, { symbol: 'BTCUSDT', window: 0 }, { trades: 0, expectancyPercent: null });
    expect(result.ok).toBe(false);
    expect(Number.isNaN(result.deltaExpectancy)).toBe(true);
  });
});
