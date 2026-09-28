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

/** Like `cell()`, but for a caller-supplied grid -- a rank scheme, unlike the
 * fixed tanh `GRID` above. */
function rankCell(
  window: number,
  symbols: ExposureSymbolInput[],
  grid: ExposureGrid,
  params: Record<string, number> = { schemeIndex: 0, legs: grid.legs ?? 1, bandFraction: 0 },
  options = {}
): ExposureCellRun {
  return {
    window,
    params,
    symbols,
    grid,
    options,
    result: simulateExposure(symbols, grid, options),
  };
}

/** Pooled mean of a cell set's cost plus funding return, in percent, over the
 * same finite bars `poolExposureResults` concatenates. The other half of the
 * per-leg identity: long + short = net - cost - funding, restated as
 * `long% + short% = mean% - meanCostAndFundingPercent(cells)`. */
function meanCostAndFundingPercent(cells: readonly ExposureCellRun[]): number {
  const values: number[] = [];
  for (const c of cells) {
    for (let i = 0; i < c.result.netReturns.length; i++) {
      if (!Number.isFinite(c.result.netReturns[i])) continue;
      values.push(c.result.costReturns[i] + c.result.fundingReturns[i]);
    }
  }
  if (values.length === 0) return 0;
  return (values.reduce((a, b) => a + b, 0) / values.length) * 100;
}

/**
 * Five symbols whose z at bar t is `factorSign` times the cross-sectionally
 * demeaned return from t to t+1: `z[i][t] = factorSign * (r[i][t] -
 * mean_i(r[i][t]))`. `crossSectionalTargets` multiplies by `factorSign`
 * again before ranking (`signed = z * factorSign`), so the value it actually
 * ranks on is `factorSign^2 * (r[i][t] - mean) = r[i][t] - mean` regardless
 * of which factorSign this fixture and the grid agree to use. A rank book
 * built on it is therefore right by construction: every bar, it longs the
 * best forward performer and shorts the worst.
 */
function crossSectionalFactorFixture(
  n: number,
  factorSign: 1 | -1,
  seed: number
): ExposureSymbolInput[] {
  const symbolCount = 5;
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const returns: number[][] = Array.from({ length: symbolCount }, () => []);
  for (let t = 0; t < n - 1; t++) {
    for (let i = 0; i < symbolCount; i++) {
      returns[i].push((rand() - 0.5) * 0.06);
    }
  }

  const closes: number[][] = Array.from({ length: symbolCount }, () => [100]);
  for (let t = 0; t < n - 1; t++) {
    for (let i = 0; i < symbolCount; i++) {
      const prev = closes[i][t];
      closes[i].push(prev * (1 + returns[i][t]));
    }
  }

  const z: number[][] = Array.from({ length: symbolCount }, () => new Array(n).fill(0));
  for (let t = 0; t < n - 1; t++) {
    let rowSum = 0;
    for (let i = 0; i < symbolCount; i++) rowSum += returns[i][t];
    const rowMean = rowSum / symbolCount;
    for (let i = 0; i < symbolCount; i++) z[i][t] = factorSign * (returns[i][t] - rowMean);
  }

  return Array.from({ length: symbolCount }, (_, i) => ({
    symbol: `SYM${i}USDT`,
    timestamps: closes[i].map((_, t) => t * DAY),
    closes: closes[i],
    fundingRates: closes[i].map(() => 0),
    z: z[i],
  }));
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

  it('pools per-leg returns, net exposure and the drop-BTC jackknife', () => {
    const rankUniverse = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT'];
    const rankGrid: ExposureGrid = {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1h',
      scheme: 'topBottom',
      legs: 1,
      factorSign: -1,
      minCrossSection: 5,
    };
    const rankSymbols = [
      symbol('BTCUSDT', 400, 0.0005, 61, -2),
      symbol('ETHUSDT', 400, 0.0004, 62, -1),
      symbol('SOLUSDT', 400, 0.0003, 63, 0),
      symbol('ADAUSDT', 400, 0.0002, 64, 1),
      symbol('XRPUSDT', 400, 0.0001, 65, 2),
    ];
    const selectedRankCells = [rankCell(0, rankSymbols, rankGrid)];

    const stats = poolExposureResults(selectedRankCells, selectedRankCells, rankUniverse, {
      interval: '1h',
      seed: 1,
      trials: 9,
      bootstrapIterations: 50,
      timingDraws: 10,
    });

    // A topBottom k=1 book long the lowest reading and short the highest
    // (factorSign -1) rebalances to a fixed +0.5/-0.5 leg here, since every
    // symbol's z is constant: the net exposure summed across the book is
    // zero on every complete bar, by construction of the rank scheme.
    expect(stats.meanAbsNetExposure).toBeLessThan(1e-9);
    expect(stats.longLegMeanReturnPercent).not.toBeNull();
    expect(stats.shortLegMeanReturnPercent).not.toBeNull();
    expect(
      (stats.longLegMeanReturnPercent as number) + (stats.shortLegMeanReturnPercent as number)
    ).toBeCloseTo(
      (stats.meanReturnPercent as number) - meanCostAndFundingPercent(selectedRankCells),
      6
    );
    expect(stats.jackknifeWithoutBtcMeanReturnPercent).not.toBeNull();
  });

  it('jackknifeWithoutBtc is null when BTCUSDT is not in the universe', () => {
    const universeNoBtc = ['ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT'];
    const rankGrid: ExposureGrid = {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1h',
      scheme: 'topBottom',
      legs: 1,
      factorSign: -1,
      minCrossSection: 4,
    };
    const rankSymbols = [
      symbol('ETHUSDT', 400, 0.0004, 62, -1.5),
      symbol('SOLUSDT', 400, 0.0003, 63, -0.5),
      symbol('ADAUSDT', 400, 0.0002, 64, 0.5),
      symbol('XRPUSDT', 400, 0.0001, 65, 1.5),
    ];
    const selectedRankCells = [rankCell(0, rankSymbols, rankGrid)];

    const stats = poolExposureResults(selectedRankCells, selectedRankCells, universeNoBtc, {
      interval: '1h',
      seed: 1,
      trials: 9,
      bootstrapIterations: 50,
      timingDraws: 10,
    });

    expect(stats.jackknifeWithoutBtcMeanReturnPercent).toBeNull();
  });

  it('the timing null destroys the cross-section: a factor equal to the next demeaned return scores p at the floor, its per-symbol shuffle does not', () => {
    const symbols = crossSectionalFactorFixture(240, -1, 777);
    const universeFive = symbols.map((s) => s.symbol);
    const grid: ExposureGrid = {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
      scheme: 'topBottom',
      legs: 1,
      factorSign: -1,
      minCrossSection: 5,
    };
    const built = rankCell(0, symbols, grid);

    const pooled = poolExposureResults([built], [built], universeFive, {
      interval: '1d',
      seed: 9,
      trials: 1,
      timingDraws: 100,
    });

    expect(pooled.timingP).not.toBeNull();
    expect(pooled.timingP as number).toBeLessThanOrEqual(0.02);
    expect(pooled.meanReturnPercent as number).toBeGreaterThan(0);
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

  it('a Phase 5 report without the new fields still validates', () => {
    const pooled = {
      ...buildMinimalPooled(),
      meanAbsNetExposure: 0.0002,
      longLegMeanReturnPercent: 0.02,
      shortLegMeanReturnPercent: -0.01,
      jackknifeWithoutBtcMeanReturnPercent: 0.005,
    };
    const report = {
      schemaVersion: 1,
      taskId: 'p3',
      datasetManifestHash: 'abc',
      lockboxApplied: true,
      factor: 'realizedVol20',
      interval: '1h',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      dateRange: { startMs: 0, endMs: 1 },
      gridCells: 9,
      trials: 54,
      mode: 'rank',
      factorSign: -1,
      minCrossSection: 5,
      selectMetric: 'meanReturn',
      fill: 'taker',
      excludedSymbols: ['BTCUSDT'],
      costs: { feePercent: 0.0005, slippageBps: 2 },
      windowConfig: { mode: 'rolling', trainFraction: 0.4, count: 6, minIsSharpeBars: 100 },
      stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
      bootstrap: { iterations: 1000, seed: 42, meanBlockLen: 40 },
      timing: { draws: 200, blockLength: 40 },
      perSymbol: [],
      windows: [],
      pooled,
      gates: [],
      pass: false,
      computedAt: '2026-09-27T00:00:00.000Z',
      gitCommit: 'abc1234',
      durationMs: 10,
    };

    // With the new fields present, this is what a rank-book run's own report
    // looks like. Confirm it validates AND that the new fields actually
    // survive parsing -- a plain z.object strips an undeclared key silently
    // rather than erroring (the payoffRatio incident this program already
    // hit once), so "validates" alone would not prove the fields were
    // declared.
    const rankResult = validateExposureReport(report);
    expect(rankResult.ok).toBe(true);
    if (rankResult.ok) {
      expect(rankResult.data.mode).toBe('rank');
      expect(rankResult.data.factorSign).toBe(-1);
      expect(rankResult.data.minCrossSection).toBe(5);
      expect(rankResult.data.selectMetric).toBe('meanReturn');
      expect(rankResult.data.fill).toBe('taker');
      expect(rankResult.data.excludedSymbols).toEqual(['BTCUSDT']);
      expect(rankResult.data.pooled.meanAbsNetExposure).toBe(0.0002);
      expect(rankResult.data.pooled.longLegMeanReturnPercent).toBe(0.02);
      expect(rankResult.data.pooled.shortLegMeanReturnPercent).toBe(-0.01);
      expect(rankResult.data.pooled.jackknifeWithoutBtcMeanReturnPercent).toBe(0.005);
    }

    // structuredClone with every new key deleted: the shape a Phase 5
    // (tanh-only) report was always written in. Every new field is optional
    // for exactly this reason.
    const phase5Report = structuredClone(report) as Record<string, unknown>;
    delete phase5Report.mode;
    delete phase5Report.factorSign;
    delete phase5Report.minCrossSection;
    delete phase5Report.selectMetric;
    delete phase5Report.fill;
    delete phase5Report.excludedSymbols;
    const phase5Pooled = phase5Report.pooled as Record<string, unknown>;
    delete phase5Pooled.meanAbsNetExposure;
    delete phase5Pooled.longLegMeanReturnPercent;
    delete phase5Pooled.shortLegMeanReturnPercent;
    delete phase5Pooled.jackknifeWithoutBtcMeanReturnPercent;

    const result = validateExposureReport(phase5Report);
    expect(result.ok).toBe(true);
  });

  it('rejects an unrecognised mode or factorSign value', () => {
    const base = {
      schemaVersion: 1,
      taskId: 'p3',
      datasetManifestHash: 'abc',
      lockboxApplied: true,
      factor: 'realizedVol20',
      interval: '1h',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      dateRange: { startMs: 0, endMs: 1 },
      gridCells: 9,
      trials: 54,
      mode: 'rank',
      factorSign: -1,
      minCrossSection: 5,
      selectMetric: 'meanReturn',
      fill: 'taker',
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
      computedAt: '2026-09-27T00:00:00.000Z',
      gitCommit: 'abc1234',
      durationMs: 10,
    };

    const badMode = { ...base, mode: 'Rank' };
    expect(validateExposureReport(badMode).ok).toBe(false);

    const badFactorSign = { ...base, factorSign: 2 };
    expect(validateExposureReport(badFactorSign).ok).toBe(false);
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
