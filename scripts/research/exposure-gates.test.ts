import { describe, expect, it } from 'vitest';

import { ExposureReportSchema, validateExposureReport } from './report-schema';
import { simulateExposure, type ExposureGrid, type ExposureSymbolInput } from './exposure-sim';
import {
  EXPOSURE_GATE_NAMES,
  EXPOSURE_PROTOCOL,
  evaluateExposureGates,
  minBarsHeldFor,
  poolExposureResults,
  type ExposureCellRun,
} from './exposure-gates';

const DAY = 24 * 60 * 60 * 1000;

/** A deterministic pseudo-random walk so a cell has a real Sharpe and a real
 * drawdown. No Math.random: a flaky gate test is worse than no test. */
function walk(n: number, drift: number, seed: number): number[] {
  const out = [100];
  let s = seed;
  for (let i = 1; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const shock = (s / 0x7fffffff - 0.5) * 0.02;
    out.push(out[i - 1] * (1 + drift + shock));
  }
  return out;
}

function symbol(
  name: string,
  n: number,
  drift: number,
  seed: number,
  zValue: number
): ExposureSymbolInput {
  const closes = walk(n, drift, seed);
  return {
    symbol: name,
    timestamps: closes.map((_, i) => i * DAY),
    closes,
    fundingRates: closes.map(() => 0),
    z: closes.map(() => zValue),
  };
}

const GRID: ExposureGrid = { band: 0, zScale: 1, smoothing: 0, gross: 1, interval: '1d' };

function cell(
  window: number,
  symbols: ExposureSymbolInput[],
  params: Record<string, number> = { band: 0 },
  options = {}
): ExposureCellRun {
  return {
    window,
    params,
    symbols,
    grid: GRID,
    options,
    result: simulateExposure(symbols, GRID, options),
  };
}

describe('EXPOSURE_PROTOCOL', () => {
  it('carries the same eight gate names as the discrete path', () => {
    expect([...EXPOSURE_GATE_NAMES]).toEqual([
      'sample',
      'expectancy',
      'windows',
      'symbols',
      'timing',
      'trials',
      'stress',
      'plateau',
    ]);
  });

  it('keeps the controller thresholds unchanged', () => {
    expect(EXPOSURE_PROTOCOL.minWindowPositiveShare).toBe(0.6);
    expect(EXPOSURE_PROTOCOL.maxTimingP).toBe(0.05);
    expect(EXPOSURE_PROTOCOL.minDeflatedSharpeProbability).toBe(0.95);
    expect(EXPOSURE_PROTOCOL.minPlateauScore).toBe(0.6);
    expect(EXPOSURE_PROTOCOL.stress).toEqual({ feeMultiplier: 1.5, slippageMultiplier: 2 });
  });

  it('restates the sample gate in bars, with 5m needing more', () => {
    expect(minBarsHeldFor('1d')).toBe(100);
    expect(minBarsHeldFor('4h')).toBe(100);
    expect(minBarsHeldFor('5m')).toBe(300);
  });
});

describe('poolExposureResults', () => {
  const universe = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];

  it('derives the block length from the holding horizon, never cbrt(n)', () => {
    // A constant signal means one rebalance and then never again, so the
    // realised spacing is the whole sample and the rule returns it rather
    // than the floor. cbrt(n) on the same bar count is a different number.
    const symbols = universe.map((s, i) => symbol(s, 3000, 0.0001, 7 + i, -1));
    const pooled = poolExposureResults(
      [cell(0, symbols)],
      [cell(0, symbols)],
      universe,
      { interval: '1d', seed: 42, trials: 36, timingDraws: 5 }
    );

    expect(pooled.bootstrap.meanBlockLen).toBeGreaterThan(32);
    expect(pooled.bootstrap.meanBlockLen).not.toBe(Math.round(Math.cbrt(pooled.barsTotal)));
    expect(pooled.meanBarsBetweenRebalances).not.toBeNull();
  });

  it('counts every held bar as a bet and reports the exposure share', () => {
    const symbols = universe.map((s, i) => symbol(s, 500, 0.0001, 11 + i, -1));
    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    expect(pooled.barsHeld).toBeGreaterThan(0);
    expect(pooled.exposureShare).toBeGreaterThan(0.9);
  });

  it('reports a zero exposure share when the factor never fires', () => {
    // z = 0 gives a target of 0, so nothing is ever held.
    const symbols = universe.map((s, i) => symbol(s, 500, 0.0001, 13 + i, 0));
    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    expect(pooled.barsHeld).toBe(0);
    expect(pooled.exposureShare).toBe(0);
  });

  it('the drop-one jackknife actually subtracts the symbol', () => {
    // Two weak losers and one strong winner. Removing the winner must leave a
    // NEGATIVE portfolio, which is the whole point of the jackknife: it asks
    // whether any single symbol is carrying the result, where a plain
    // positive-share count cannot tell a symbol that matters from one that
    // happens to be positive.
    const loserA = symbol('AAAUSDT', 800, -0.001, 21, -1);
    const loserB = symbol('BBBUSDT', 800, -0.001, 22, -1);
    const winner = symbol('CCCUSDT', 800, 0.006, 23, -1);
    const all = [loserA, loserB, winner];

    const pooled = poolExposureResults([cell(0, all)], [cell(0, all)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });

    expect(pooled.meanReturnPercent as number).toBeGreaterThan(0);
    expect(pooled.jackknifeWorstMeanReturnPercent).not.toBeNull();
    // The worst leave-one-out is the one without the winner, and it is worse
    // than the headline because the winner was carrying it.
    expect(pooled.jackknifeWorstMeanReturnPercent as number).toBeLessThan(
      pooled.meanReturnPercent as number
    );
    expect(pooled.jackknifePositive).toBeLessThan(pooled.jackknifeTotal);
  });

  it('the stress mean is null unless the cells actually carry stress multipliers', () => {
    const symbols = universe.map((s, i) => symbol(s, 400, 0.001, 31 + i, -1));
    const unstressed = poolExposureResults(
      [cell(0, symbols)],
      [cell(0, symbols)],
      universe,
      { interval: '1d', seed: 42, trials: 1, timingDraws: 5 }
    );
    expect(unstressed.stressMeanReturnPercent).toBeNull();

    const stressed = poolExposureResults(
      [cell(0, symbols, { band: 0 }, { feeMultiplier: 1.5, slippageMultiplier: 2 })],
      [cell(0, symbols)],
      universe,
      { interval: '1d', seed: 42, trials: 1, timingDraws: 5 }
    );
    expect(stressed.stressMeanReturnPercent).not.toBeNull();
  });

  it('produces a real mark-to-market drawdown, not a concatenated proxy', () => {
    const symbols = universe.map((s, i) => symbol(s, 600, -0.001, 41 + i, -1));
    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    expect(pooled.maxDrawdownPercent).not.toBeNull();
    expect(pooled.maxDrawdownPercent as number).toBeGreaterThan(0);
    // A compounded path can never draw down more than 100% of its own equity.
    expect(pooled.maxDrawdownPercent as number).toBeLessThanOrEqual(100);
  });

  it('every non-finite statistic is null, never NaN', () => {
    const symbols = universe.map((s, i) => symbol(s, 3, 0.001, 51 + i, -1));
    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    for (const [key, value] of Object.entries(pooled)) {
      if (typeof value === 'number') {
        expect(Number.isNaN(value), `${key} is NaN`).toBe(false);
      }
    }
  });
});

describe('evaluateExposureGates', () => {
  const universe = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];

  it('returns exactly eight gates, each with a name, value and threshold', () => {
    const symbols = universe.map((s, i) => symbol(s, 500, 0.001, 61 + i, -1));
    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    const { gates, pass } = evaluateExposureGates(pooled, '1d');

    expect(gates.map((g) => g.name)).toEqual([...EXPOSURE_GATE_NAMES]);
    for (const gate of gates) {
      expect(typeof gate.pass).toBe('boolean');
      expect(typeof gate.threshold).toBe('number');
      expect(gate.value === null || typeof gate.value === 'number').toBe(true);
    }
    expect(pass).toBe(gates.every((g) => g.pass));
  });

  it('fails the sample gate when nothing was ever held', () => {
    const symbols = universe.map((s, i) => symbol(s, 500, 0.001, 71 + i, 0));
    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    const sample = evaluateExposureGates(pooled, '1d').gates.find((g) => g.name === 'sample');
    expect(sample?.pass).toBe(false);
  });

  it('fails the symbols gate when one symbol carries the whole result', () => {
    // Two symbols whose price genuinely never moves (so their only
    // contribution is the entry cost) and one strong winner: removing the
    // winner kills the portfolio, so the jackknife must fail even though the
    // pooled number is positive.
    const flat = (name: string) => ({
      symbol: name,
      timestamps: Array.from({ length: 800 }, (_, i) => i * DAY),
      closes: Array.from({ length: 800 }, () => 100),
      fundingRates: Array.from({ length: 800 }, () => 0),
      z: Array.from({ length: 800 }, () => -1),
    });
    const flatA = flat('AAAUSDT');
    const flatB = flat('BBBUSDT');
    const winner = symbol('CCCUSDT', 800, 0.004, 83, -1);
    const symbols = [flatA, flatB, winner];

    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    const symbolsGate = evaluateExposureGates(pooled, '1d').gates.find(
      (g) => g.name === 'symbols'
    );

    expect(pooled.jackknifePositive).toBeLessThan(pooled.jackknifeTotal);
    expect(symbolsGate?.pass).toBe(false);
    expect(symbolsGate?.note).toMatch(/Drop-one-symbol jackknife/);
  });

  it('fails the stress gate when the stress cells are absent', () => {
    const symbols = universe.map((s, i) => symbol(s, 500, 0.001, 91 + i, -1));
    const pooled = poolExposureResults([cell(0, symbols)], [cell(0, symbols)], universe, {
      interval: '1d',
      seed: 42,
      trials: 1,
      timingDraws: 5,
    });
    const stress = evaluateExposureGates(pooled, '1d').gates.find((g) => g.name === 'stress');
    expect(stress?.value).toBeNull();
    expect(stress?.pass).toBe(false);
  });
});

describe('ExposureReportSchema', () => {
  it('is a separate schema and strips nothing it was not told about', () => {
    // The payoffRatio incident, restated as a test: a field present in the
    // parsed output proves it was declared, and a field that was not declared
    // must not survive.
    const parsed = ExposureReportSchema.parse({
      schemaVersion: 1,
      taskId: 'p5',
      datasetManifestHash: 'abc',
      lockboxApplied: true,
      factor: 'positioningZ360',
      interval: '1d',
      symbols: ['BTCUSDT'],
      dateRange: { startMs: null, endMs: null },
      gridCells: 36,
      trials: 36,
      costs: { feePercent: 0.0005, slippageBps: 2 },
      windowConfig: { mode: 'rolling', trainFraction: 0.4, count: 6, minIsSharpeBars: 100 },
      stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
      bootstrap: { iterations: 1000, seed: 42, meanBlockLen: 40 },
      timing: { draws: 200, blockLength: 40 },
      perSymbol: [
        { symbol: 'BTCUSDT', bars: 10, meanContributionPercent: 0.01, positive: true },
      ],
      windows: [
        {
          window: 0,
          params: { band: 0.25 },
          bars: 10,
          positive: true,
          sharpe: 0.1,
          meanReturnPercent: 0.01,
        },
      ],
      pooled: buildMinimalPooled(),
      gates: [{ name: 'sample', pass: true, value: 500, threshold: 100 }],
      pass: true,
      computedAt: '2026-09-21T00:00:00.000Z',
      gitCommit: 'abc1234',
      durationMs: 10,
      somethingUndeclared: 'should not survive',
    });

    expect('somethingUndeclared' in parsed).toBe(false);
    expect(parsed.pooled.meanReturnPercent).toBe(0.01);
  });

  it('round-trips through its own validator', () => {
    const report = {
      schemaVersion: 1,
      taskId: 'p5',
      datasetManifestHash: 'abc',
      lockboxApplied: true,
      factor: 'positioningZ360',
      interval: '4h',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      dateRange: { startMs: 0, endMs: 1 },
      gridCells: 36,
      trials: 36,
      costs: { feePercent: 0.0005, slippageBps: 2 },
      windowConfig: { mode: 'rolling', trainFraction: 0.4, count: 6, minIsSharpeBars: 100 },
      stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
      bootstrap: { iterations: 1000, seed: 42, meanBlockLen: 40 },
      timing: { draws: 200, blockLength: 40 },
      perSymbol: [],
      windows: [],
      pooled: buildMinimalPooled(),
      gates: [],
      pass: false,
      computedAt: '2026-09-21T00:00:00.000Z',
      gitCommit: 'abc1234',
      durationMs: 10,
    };
    const result = validateExposureReport(report);
    expect(result.ok).toBe(true);
  });

  it('rejects a report missing a declared field', () => {
    const result = validateExposureReport({ schemaVersion: 1, taskId: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
});

/** A pooled block with every field present and null where a run had no data. */
function buildMinimalPooled() {
  return {
    barsHeld: 500,
    barsTotal: 510,
    exposureShare: 0.98,
    meanReturnPercent: 0.01,
    sharpe: 0.05,
    sharpeCi95: [0.01, 0.09],
    maxDrawdownPercent: 3.2,
    bootstrap: { iterations: 1000, seed: 42, meanBlockLen: 40 },
    windowsTotal: 6,
    windowsPositive: 5,
    windowPositiveShare: 0.833,
    symbolsTotal: 10,
    symbolsPositive: 7,
    symbolPositiveShare: 0.7,
    jackknifeTotal: 10,
    jackknifePositive: 8,
    jackknifeWorstMeanReturnPercent: -0.002,
    timingDraws: 200,
    timingP: 0.03,
    trials: 36,
    deflatedSharpe: {
      observedSharpe: 0.05,
      benchmarkSharpe: 0.02,
      probability: 0.96,
      radicand: 0.9,
      varianceOfTrialSharpes: 0.001,
    },
    plateau: {
      score: 0.7,
      neighbors: 3,
      bestMetric: 0.01,
      bestParams: { band: 0.25 },
      neighborRadius: 1,
    },
    stressMeanReturnPercent: 0.002,
    totalTurnover: 12.5,
    meanBarsBetweenRebalances: 40,
  };
}
