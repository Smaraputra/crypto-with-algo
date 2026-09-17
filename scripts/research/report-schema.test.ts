// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SURVIVOR_RULE,
  checkFindings,
  checkReportConsistency,
  evaluateSurvivors,
  spotCheckCell,
  validateFactorIcReport,
  validateSubagentReport,
  type FactorIcReport,
  type FactorReport,
  type HorizonStat,
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
      minT: 2.5,
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
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.0 }),
          makeHorizonStat({ horizon: 2, ic: 0.04, icT: 2.8 }),
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
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.0 }),
          makeHorizonStat({ horizon: 2, ic: 0.04, icT: 2.8 }),
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
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.0 }),
          makeHorizonStat({ horizon: 2, ic: 0.04, icT: 2.8 }),
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
          makeHorizonStat({ horizon: 1, ic: 0.05, icT: 3.0 }),
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
