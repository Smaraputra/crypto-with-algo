// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bootstrapCi, maxDrawdownPercentOfPnl, meanOf } from '@/lib/stats/block-bootstrap';
import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import {
  VALIDATION_PROTOCOL,
  evaluateStrategyGates,
  minOosTradesFor,
  poolStrategyResults,
  type PooledStats,
} from './strategy-gates';
import type {
  OosTrade,
  StrategyWalkForwardResult,
  WindowConfig,
  WindowResult,
} from './strategy-walk-forward';

const HOUR = 3_600_000;

function makeTrade(overrides: Partial<OosTrade> = {}): OosTrade {
  return {
    entryTime: 0,
    exitTime: 0,
    side: 'long',
    pnl: 10,
    pnlPercent: 1,
    riskPercent: 2,
    holdTimeBars: 4,
    exitReason: 'signal',
    fees: 1,
    slippageCost: 0.1,
    fundingCost: 0,
    ...overrides,
  };
}

function makeWindowConfig(overrides: Partial<WindowConfig> = {}): WindowConfig {
  return {
    trainBars: 100,
    testWindowBars: 50,
    purgeGapBars: 10,
    stepSizeBars: 50,
    mode: 'anchored',
    count: 1,
    ...overrides,
  };
}

function oosFromTrades(trades: OosTrade[]): WindowResult['oos'] {
  if (trades.length === 0) return null;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const positiveSum = wins.reduce((s, t) => s + t.pnl, 0);
  const negativeSumAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    trades: trades.length,
    expectancyPercent: meanOf(trades.map((t) => t.pnlPercent)),
    expectancyR: meanOf(trades.map((t) => t.pnlPercent / t.riskPercent)),
    winRate: wins.length / trades.length,
    profitFactor: negativeSumAbs === 0 ? Infinity : positiveSum / negativeSumAbs,
    maxDrawdownPercent: 0,
    medianHoldBars: trades[0].holdTimeBars,
    fees: trades.reduce((s, t) => s + t.fees, 0),
    slippageCost: trades.reduce((s, t) => s + t.slippageCost, 0),
    fundingCost: trades.reduce((s, t) => s + t.fundingCost, 0),
    snapshotCoveragePercent: null,
  };
}

/** One window, one grid cell (single-cell family): oosCells mirrors oosTrades exactly. */
function makeWindow(
  index: number,
  trades: OosTrade[],
  overrides: Partial<WindowResult> = {}
): WindowResult {
  const oos = oosFromTrades(trades);
  return {
    index,
    trainStart: 0,
    trainEnd: 99,
    testStart: 110,
    testEnd: 159,
    selectedParams: trades.length > 0 || oos !== null ? {} : null,
    skippedReason: null,
    isCells: [
      {
        params: {},
        trades: trades.length,
        expectancyPercent: oos?.expectancyPercent ?? 0,
        expectancyR: oos?.expectancyR ?? null,
        perTradeSharpe: 0,
        winRate: oos?.winRate ?? 0,
        profitFactor: oos?.profitFactor ?? 0,
        maxDrawdownPercent: 0,
      },
    ],
    oosCells: [
      {
        params: {},
        trades: trades.length,
        expectancyPercent: oos?.expectancyPercent ?? 0,
        pnlPercents: trades.map((t) => t.pnlPercent),
      },
    ],
    oos,
    oosTrades: trades,
    stress: null,
    benchmark: null,
    ...overrides,
  };
}

function makeResult(symbol: string, windows: WindowResult[]): StrategyWalkForwardResult {
  return { symbol, interval: '1h', style: 'day_trading', windowConfig: makeWindowConfig(), windows };
}

const ONE_CELL = [{}];
const BOOTSTRAP_OPTS = { bootstrapIterations: 200, seed: 42 };

describe('minOosTradesFor', () => {
  it('is 300 for 5m and 100 for every other interval', () => {
    expect(minOosTradesFor('5m')).toBe(300);
    expect(minOosTradesFor('1h')).toBe(100);
    expect(minOosTradesFor('4h')).toBe(100);
    expect(minOosTradesFor('1d')).toBe(100);
    expect(minOosTradesFor('15m')).toBe(100);
  });

  it('matches VALIDATION_PROTOCOL.minOosTrades verbatim', () => {
    expect(VALIDATION_PROTOCOL.minOosTrades).toEqual({ default: 100, '5m': 300 });
  });
});

describe('poolStrategyResults: basic pooling', () => {
  const tradeA1 = makeTrade({ exitTime: 1_000, pnl: 100, pnlPercent: 2, riskPercent: 2, holdTimeBars: 4 });
  const tradeA2 = makeTrade({ exitTime: 2_000, pnl: -50, pnlPercent: -1, riskPercent: 2, holdTimeBars: 6 });
  const tradeB1 = makeTrade({ exitTime: 1_500, pnl: 80, pnlPercent: 1.5, riskPercent: 1.5, holdTimeBars: 3 });

  const windowA = makeWindow(0, [tradeA1, tradeA2]);
  const windowB = makeWindow(0, [tradeB1]);
  const perSymbol = [makeResult('AAAUSDT', [windowA]), makeResult('BBBUSDT', [windowB])];

  const pooled = poolStrategyResults(perSymbol, {
    interval: '1h',
    cells: ONE_CELL,
    familyCount: 1,
    bootstrapIterations: 200,
    seed: 7,
  });

  it('sorts pooled trades by exit time and counts them', () => {
    expect(pooled.n).toBe(3);
  });

  it('computes expectancyPercent as the mean pnlPercent', () => {
    expect(pooled.expectancyPercent).toBeCloseTo((2 + 1.5 - 1) / 3, 12);
  });

  it('computes expectancyR as the mean of pnlPercent/riskPercent', () => {
    expect(pooled.expectancyR).toBeCloseTo((2 / 2 + 1.5 / 1.5 + -1 / 2) / 3, 12);
  });

  it('computes winRate as the share of trades with pnl above 0', () => {
    expect(pooled.winRate).toBeCloseTo(2 / 3, 12);
  });

  it('computes profitFactor as positive pnl sum over absolute negative pnl sum', () => {
    expect(pooled.profitFactor).toBeCloseTo((100 + 80) / 50, 12);
  });

  it('computes medianHoldBars as the median of holdTimeBars', () => {
    expect(pooled.medianHoldBars).toBe(4);
  });

  it('computes avgWin, avgLoss and payoffRatio in percent terms', () => {
    expect(pooled.avgWinPercent).toBeCloseTo((2 + 1.5) / 2, 12);
    expect(pooled.avgLossPercent).toBeCloseTo(1, 12);
    expect(pooled.payoffRatio).toBeCloseTo(1.75, 12);
  });

  it('nulls the payoff ratio rather than dividing by an absent leg', () => {
    const allWinners = [makeResult('AAAUSDT', [makeWindow(0, [tradeA1, tradeB1])])];
    const noLosses = poolStrategyResults(allWinners, {
      interval: '1h', cells: ONE_CELL, familyCount: 1, bootstrapIterations: 50, seed: 7,
    });
    expect(noLosses.avgLossPercent).toBeNull();
    expect(noLosses.payoffRatio).toBeNull();
  });

  it('keeps the payoff ratio out of every gate', () => {
    // Reported only. Nothing selects on it and no gate reads it; expectancy
    // stays the objective. A payoff ratio can be bought by widening the
    // target, which is exactly why it must not be a criterion.
    const names = evaluateStrategyGates(pooled, '1h').gates.map((g) => g.name);
    expect(names).not.toContain('payoff');
    expect(names).not.toContain('winRate');
    expect(names).toHaveLength(8);
  });

  it('computes maxDrawdownPercent via maxDrawdownPercentOfPnl on pnl in exit order', () => {
    expect(pooled.maxDrawdownPercent).toBeCloseTo(maxDrawdownPercentOfPnl([100, 80, -50], 10000), 12);
  });

  it('computes a bootstrapCi95 and records the bootstrap settings used', () => {
    expect(pooled.bootstrapCi95).not.toBeNull();
    const meanBlockLen = Math.max(2, Math.round(Math.cbrt(3)));
    expect(pooled.bootstrap).toEqual({ iterations: 200, seed: 7, meanBlockLen });
    const expected = bootstrapCi([2, 1.5, -1], meanOf, { iterations: 200, meanBlockLen, seed: 7 });
    expect(pooled.bootstrapCi95).toEqual([expected.low, expected.high]);
  });

  it('counts every (symbol, window) pair and every symbol', () => {
    expect(pooled.windowsTotal).toBe(2);
    expect(pooled.windowsPositive).toBe(2);
    expect(pooled.windowPositiveShare).toBe(1);
    expect(pooled.symbolsTotal).toBe(2);
    expect(pooled.symbolsPositive).toBe(2);
    expect(pooled.symbolPositiveShare).toBe(1);
  });

  it('has no benchmark windows and a null randomEntryP', () => {
    expect(pooled.benchmarkWindows).toBe(0);
    expect(pooled.randomEntryP).toBeNull();
  });

  it('defaults trials to cells.length * familyCount', () => {
    expect(pooled.trials).toBe(1);
  });

  it('computes a deflatedSharpe block since n >= 2', () => {
    expect(pooled.deflatedSharpe).not.toBeNull();
    const pnlPercents = [2, 1.5, -1];
    const observedSharpe = perPeriodSharpe(pnlPercents);
    expect(pooled.deflatedSharpe!.observedSharpe).toBeCloseTo(observedSharpe, 12);
  });

  it('leaves plateau null for a single-cell grid', () => {
    expect(pooled.plateau).toBeNull();
  });

  it('has no stress records', () => {
    expect(pooled.stressTrades).toBe(0);
    expect(pooled.stressExpectancyPercent).toBeNull();
  });
});

describe('poolStrategyResults: n=0 and n=1 edge cases', () => {
  it('nulls every ratio statistic when there are no trades at all', () => {
    const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, [])])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    expect(pooled.n).toBe(0);
    expect(pooled.expectancyPercent).toBeNull();
    expect(pooled.expectancyR).toBeNull();
    expect(pooled.winRate).toBeNull();
    expect(pooled.profitFactor).toBeNull();
    expect(pooled.medianHoldBars).toBeNull();
    expect(pooled.maxDrawdownPercent).toBeNull();
    expect(pooled.bootstrapCi95).toBeNull();
    expect(pooled.deflatedSharpe).toBeNull();
  });

  it('leaves deflatedSharpe null for a single pooled trade (n < 2)', () => {
    const trade = makeTrade({ exitTime: 500, pnl: 5, pnlPercent: 0.5 });
    const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, [trade])])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    expect(pooled.n).toBe(1);
    expect(pooled.bootstrapCi95).toBeNull();
    expect(pooled.deflatedSharpe).toBeNull();
  });
});

describe('poolStrategyResults: windows and symbols share, skipped windows count as not positive', () => {
  it('a skipped window (oos null) and a losing window both fail to count as positive', () => {
    const winningTrade = makeTrade({ exitTime: 1_000, pnl: 10, pnlPercent: 1 });
    const losingTrade = makeTrade({ exitTime: 2_000, pnl: -10, pnlPercent: -1 });

    const skippedWindow = makeWindow(0, [], { selectedParams: null, skippedReason: 'no cell reached minIsTrades' });
    const winningWindow = makeWindow(1, [winningTrade]);
    const losingWindow = makeWindow(0, [losingTrade]);

    const perSymbol = [
      makeResult('AAAUSDT', [skippedWindow, winningWindow]),
      makeResult('BBBUSDT', [losingWindow]),
    ];

    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    // 3 windows total (2 for AAAUSDT, 1 for BBBUSDT); only the winning one counts positive.
    expect(pooled.windowsTotal).toBe(3);
    expect(pooled.windowsPositive).toBe(1);
    expect(pooled.windowPositiveShare).toBeCloseTo(1 / 3, 12);

    // AAAUSDT's own pooled trades are just the winning one (mean > 0): positive.
    // BBBUSDT's own pooled trades are just the losing one (mean < 0): not positive.
    expect(pooled.symbolsTotal).toBe(2);
    expect(pooled.symbolsPositive).toBe(1);
    expect(pooled.symbolPositiveShare).toBe(0.5);
  });

  it('a symbol with zero selected trades across every window is not positive', () => {
    const perSymbol = [
      makeResult('AAAUSDT', [makeWindow(0, [], { selectedParams: null, skippedReason: 'skip' })]),
    ];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });
    expect(pooled.symbolsPositive).toBe(0);
    expect(pooled.symbolPositiveShare).toBe(0);
  });
});

describe('poolStrategyResults: pooled random-entry p-value', () => {
  it('matches a hand-computed p from paired iterations across two windows with different reference trade counts', () => {
    // Window 1: 3 reference trades, K=4 random draws.
    const window1RandomExpectancies = [5, -2, 3, -10];
    // Window 2: 1 reference trade, K=4 random draws (min K across windows stays 4).
    const window2RandomExpectancies = [-1, 8, -3, -4];

    const trade1 = makeTrade({ exitTime: 1_000, pnl: 30, pnlPercent: 3 });
    const window1 = makeWindow(0, [trade1], {
      benchmark: {
        iterations: 4,
        seed: 1,
        meanRandom: 0,
        sdRandom: 1,
        pValue: 0.5,
        referenceTrades: 3,
        randomExpectancies: window1RandomExpectancies,
      },
    });

    const trade2 = makeTrade({ exitTime: 2_000, pnl: 10, pnlPercent: 1 });
    const window2 = makeWindow(0, [trade2], {
      benchmark: {
        iterations: 4,
        seed: 2,
        meanRandom: 0,
        sdRandom: 1,
        pValue: 0.5,
        referenceTrades: 1,
        randomExpectancies: window2RandomExpectancies,
      },
    });

    const perSymbol = [makeResult('AAAUSDT', [window1]), makeResult('BBBUSDT', [window2])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    // pooled expectancyPercent over the 2 trades: mean(3, 1) = 2.
    expect(pooled.expectancyPercent).toBeCloseTo(2, 12);

    // pooled_k = (3*w1[k] + 1*w2[k]) / 4 for each k in 0..3.
    const totalRef = 3 + 1;
    const pooledDraws = [0, 1, 2, 3].map(
      (k) => (3 * window1RandomExpectancies[k] + 1 * window2RandomExpectancies[k]) / totalRef
    );
    // pooledDraws = [(15-1)/4, (-6+8)/4, (9-3)/4, (-30-4)/4] = [3.5, 0.5, 1.5, -8.5]
    expect(pooledDraws).toEqual([3.5, 0.5, 1.5, -8.5]);

    const countGE = pooledDraws.filter((d) => d >= 2).length; // only 3.5 >= 2
    expect(countGE).toBe(1);
    const expectedP = (1 + countGE) / (4 + 1); // (1+1)/5 = 0.4

    expect(pooled.benchmarkWindows).toBe(2);
    expect(pooled.randomEntryP).toBeCloseTo(expectedP, 12);
  });

  it('is null when no window has a benchmark record', () => {
    const trade = makeTrade({ exitTime: 1_000, pnl: 10, pnlPercent: 1 });
    const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, [trade])])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });
    expect(pooled.benchmarkWindows).toBe(0);
    expect(pooled.randomEntryP).toBeNull();
  });
});

describe('poolStrategyResults: per-cell deflatedSharpe and trials', () => {
  it('pools each cell across symbol and window for varianceOfTrialSharpes, and pools the selected trades for observedSharpe', () => {
    // Two cells; cell 0 is selected every window, cell 1 never selected but
    // still has its own oosCells pnlPercents recorded every window.
    const cells = [{ threshold: 1 }, { threshold: 2 }];

    function makeTwoCellWindow(index: number, selectedTrades: OosTrade[], otherCellPnls: number[]): WindowResult {
      const w = makeWindow(index, selectedTrades);
      return {
        ...w,
        selectedParams: cells[0],
        oosCells: [
          { params: cells[0], trades: selectedTrades.length, expectancyPercent: w.oos?.expectancyPercent ?? 0, pnlPercents: selectedTrades.map((t) => t.pnlPercent) },
          { params: cells[1], trades: otherCellPnls.length, expectancyPercent: 0, pnlPercents: otherCellPnls },
        ],
      };
    }

    const trades = [
      makeTrade({ exitTime: 1_000, pnl: 20, pnlPercent: 2 }),
      makeTrade({ exitTime: 2_000, pnl: 30, pnlPercent: 3 }),
    ];
    const window = makeTwoCellWindow(0, trades, [-1, -2, -3]);
    const perSymbol = [makeResult('AAAUSDT', [window])];

    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    expect(pooled.trials).toBe(2); // cells.length(2) * familyCount(1)

    const cell0Sharpe = perPeriodSharpe([2, 3]);
    const cell1Sharpe = perPeriodSharpe([-1, -2, -3]);
    const expectedVariance =
      ((cell0Sharpe - (cell0Sharpe + cell1Sharpe) / 2) ** 2 + (cell1Sharpe - (cell0Sharpe + cell1Sharpe) / 2) ** 2) / 1;

    expect(pooled.deflatedSharpe!.varianceOfTrialSharpes).toBeCloseTo(expectedVariance, 9);
    expect(pooled.deflatedSharpe!.observedSharpe).toBeCloseTo(perPeriodSharpe([2, 3]), 12);
  });

  it('honors trialsOverride when given', () => {
    const trades = [makeTrade({ exitTime: 1_000, pnl: 10, pnlPercent: 1 }), makeTrade({ exitTime: 2_000, pnl: 10, pnlPercent: 1 })];
    const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, trades)])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      trialsOverride: 99,
      ...BOOTSTRAP_OPTS,
    });
    expect(pooled.trials).toBe(99);
  });
});

describe('poolStrategyResults: plateau', () => {
  it('is null for a single-cell grid', () => {
    const trades = [makeTrade({ exitTime: 1_000, pnl: 10, pnlPercent: 1 })];
    const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, trades)])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });
    expect(pooled.plateau).toBeNull();
  });

  it('scores a 3-cell one-parameter grid where the neighbor sits at 60% of the best', () => {
    // threshold in {1, 2, 3}; best (threshold=2, index 1) has mean pnl 10,
    // both index-adjacent cells (threshold=1 and 3, indices 0 and 2) have
    // mean pnl 6 (60% of 10) and are neighbors (index distance 1).
    const cells = [{ threshold: 1 }, { threshold: 2 }, { threshold: 3 }];

    function makeThreeCellWindow(): WindowResult {
      const selectedTrades = [makeTrade({ exitTime: 1_000, pnl: 100, pnlPercent: 10 })];
      const w = makeWindow(0, selectedTrades);
      return {
        ...w,
        selectedParams: cells[1],
        oosCells: [
          { params: cells[0], trades: 1, expectancyPercent: 6, pnlPercents: [6] },
          { params: cells[1], trades: 1, expectancyPercent: 10, pnlPercents: [10] },
          { params: cells[2], trades: 1, expectancyPercent: 6, pnlPercents: [6] },
        ],
      };
    }

    const perSymbol = [makeResult('AAAUSDT', [makeThreeCellWindow()])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    expect(pooled.plateau).not.toBeNull();
    expect(pooled.plateau!.bestParams).toEqual({ threshold: 2 });
    expect(pooled.plateau!.bestMetric).toBeCloseTo(10, 12);
    expect(pooled.plateau!.neighborRadius).toBe(1);
    // Both threshold=1 and threshold=3 sit at index distance 1 from threshold=2.
    expect(pooled.plateau!.neighbors).toBe(2);
    expect(pooled.plateau!.score).toBeCloseTo(0.6, 12);
  });

  it('produces a null score when the best cell has non-positive expectancy', () => {
    const cells = [{ threshold: 1 }, { threshold: 2 }];
    function makeWindowWithNonPositiveBest(): WindowResult {
      const w = makeWindow(0, []);
      return {
        ...w,
        selectedParams: null,
        skippedReason: 'no cell reached minIsTrades',
        oosCells: [
          { params: cells[0], trades: 1, expectancyPercent: -5, pnlPercents: [-5] },
          { params: cells[1], trades: 1, expectancyPercent: -1, pnlPercents: [-1] },
        ],
      };
    }
    const perSymbol = [makeResult('AAAUSDT', [makeWindowWithNonPositiveBest()])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });
    expect(pooled.plateau).not.toBeNull();
    // Best is threshold=2 (metric -1, the least negative); bestMetric <= 0 forces score to NaN -> null.
    expect(pooled.plateau!.bestMetric).toBeLessThanOrEqual(0);
    expect(pooled.plateau!.score).toBeNull();
  });

  it('counts a neighbor adjacent only on the low-cardinality dimension of a mixed 5x2 grid', () => {
    // a has 5 distinct values (indices 0-4), b has 2 (indices 0-1). Best is
    // a=3 (index 2), b=10 (index 0). Every b value is always index-adjacent
    // to every other b value in a 2-value dimension, so (a=3, b=20) -- which
    // differs from the best ONLY on b -- must count as a neighbor: this is
    // exactly the case a value-normalized radius would have excluded
    // (b-adjacent cells sit at normalized distance 1.0 on a 5-value a-axis).
    const cells = [
      { a: 1, b: 10 }, { a: 1, b: 20 },
      { a: 2, b: 10 }, { a: 2, b: 20 },
      { a: 3, b: 10 }, { a: 3, b: 20 },
      { a: 4, b: 10 }, { a: 4, b: 20 },
      { a: 5, b: 10 }, { a: 5, b: 20 },
    ];
    // Metric per cell, in the same order as `cells`: best is (a=3,b=10)=10;
    // its five index-neighbors (a in {2,3,4}, b in {10,20}, minus itself)
    // are 6; the four a-distant cells (a in {1,5}) are 1 and irrelevant.
    const metricByCell = [1, 1, 6, 6, 10, 6, 6, 6, 1, 1];

    function makeMixedGridWindow(): WindowResult {
      const selectedTrades = [makeTrade({ exitTime: 1_000, pnl: 100, pnlPercent: 10 })];
      const w = makeWindow(0, selectedTrades);
      return {
        ...w,
        selectedParams: cells[4], // { a: 3, b: 10 }
        oosCells: cells.map((params, i) => ({
          params,
          trades: 1,
          expectancyPercent: metricByCell[i],
          pnlPercents: [metricByCell[i]],
        })),
      };
    }

    const perSymbol = [makeResult('AAAUSDT', [makeMixedGridWindow()])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    expect(pooled.plateau).not.toBeNull();
    expect(pooled.plateau!.bestParams).toEqual({ a: 3, b: 10 });
    expect(pooled.plateau!.bestMetric).toBeCloseTo(10, 12);
    expect(pooled.plateau!.neighborRadius).toBe(1);
    expect(pooled.plateau!.neighbors).toBe(5);
    expect(pooled.plateau!.score).toBeCloseTo(0.6, 12);
  });
});

describe('poolStrategyResults: stress', () => {
  it('sums stress trades and pools every stress pnlPercent into one mean', () => {
    const w1 = makeWindow(0, [makeTrade({ exitTime: 1_000, pnl: 10, pnlPercent: 1 })], {
      stress: { trades: 3, expectancyPercent: 0.5, pnlPercents: [1, 0, -0.5] },
    });
    const w2 = makeWindow(1, [makeTrade({ exitTime: 2_000, pnl: 10, pnlPercent: 1 })], {
      stress: { trades: 2, expectancyPercent: 2, pnlPercents: [2, 2] },
    });
    const perSymbol = [makeResult('AAAUSDT', [w1, w2])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    expect(pooled.stressTrades).toBe(5);
    expect(pooled.stressExpectancyPercent).toBeCloseTo(meanOf([1, 0, -0.5, 2, 2]), 12);
  });

  it('is null when no window has a stress record', () => {
    const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, [makeTrade({ exitTime: 1_000 })])])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });
    expect(pooled.stressTrades).toBe(0);
    expect(pooled.stressExpectancyPercent).toBeNull();
  });
});

describe('poolStrategyResults: per-year grouping across a year boundary', () => {
  it('groups pooled trades by the UTC year of exitTime, ascending', () => {
    const dec2025 = Date.UTC(2025, 11, 31, 23, 0, 0);
    const jan2026a = Date.UTC(2026, 0, 1, 1, 0, 0);
    const jan2026b = Date.UTC(2026, 0, 15, 0, 0, 0);

    const trades = [
      makeTrade({ exitTime: dec2025, pnl: 10, pnlPercent: 1 }),
      makeTrade({ exitTime: jan2026a, pnl: 20, pnlPercent: 2 }),
      makeTrade({ exitTime: jan2026b, pnl: -10, pnlPercent: -1 }),
    ];
    const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, trades)])];
    const pooled = poolStrategyResults(perSymbol, {
      interval: '1h',
      cells: ONE_CELL,
      familyCount: 1,
      ...BOOTSTRAP_OPTS,
    });

    expect(pooled.perYear).toEqual([
      { year: 2025, trades: 1, expectancyPercent: 1 },
      { year: 2026, trades: 2, expectancyPercent: 0.5 },
    ]);
  });
});

describe('poolStrategyResults: bootstrap determinism', () => {
  const trades = Array.from({ length: 10 }, (_, i) =>
    makeTrade({ exitTime: i * HOUR, pnl: (i % 3) - 1, pnlPercent: (i % 3) - 1 })
  );
  const perSymbol = [makeResult('AAAUSDT', [makeWindow(0, trades)])];

  it('produces an identical bootstrapCi95 across two calls with the same seed', () => {
    const pooledA = poolStrategyResults(perSymbol, { interval: '1h', cells: ONE_CELL, familyCount: 1, bootstrapIterations: 100, seed: 11 });
    const pooledB = poolStrategyResults(perSymbol, { interval: '1h', cells: ONE_CELL, familyCount: 1, bootstrapIterations: 100, seed: 11 });
    expect(pooledA.bootstrapCi95).toEqual(pooledB.bootstrapCi95);
  });

  it('produces a different bootstrapCi95 with a different seed', () => {
    const pooledA = poolStrategyResults(perSymbol, { interval: '1h', cells: ONE_CELL, familyCount: 1, bootstrapIterations: 100, seed: 11 });
    const pooledC = poolStrategyResults(perSymbol, { interval: '1h', cells: ONE_CELL, familyCount: 1, bootstrapIterations: 100, seed: 12 });
    expect(pooledA.bootstrapCi95).not.toEqual(pooledC.bootstrapCi95);
  });
});

// ---------------------------------------------------------------------------
// evaluateStrategyGates
//
// psrRadicand is provably non-negative for any finite pnlPercent sample: for
// the standardized deviations of ANY real dataset, kurtosis >= skewness^2 + 1
// (Cauchy-Schwarz applied to Cov(Y, Y^2)), which makes
// 1 - skew*sharpe + (kurt-1)/4*sharpe^2 >= (1 - skew*sharpe/2)^2 >= 0 always.
// So the "radicand <= 0" branch is only reachable via a hand-built PooledStats
// (evaluateStrategyGates takes pooled stats, not raw trades, so this is a
// legitimate direct construction, not a workaround), never via real trade
// data pooled through poolStrategyResults.
// ---------------------------------------------------------------------------

function makeBasePooled(overrides: Partial<PooledStats> = {}): PooledStats {
  return {
    n: 150,
    expectancyPercent: 1,
    expectancyR: 0.5,
    winRate: 0.55,
    profitFactor: 1.8,
    avgWinPercent: 2.2,
    avgLossPercent: 1.2,
    payoffRatio: 2.2 / 1.2,
    medianHoldBars: 5,
    maxDrawdownPercent: 3,
    bootstrapCi95: [0.2, 1.8],
    bootstrap: { iterations: 1000, seed: 42, meanBlockLen: 5 },
    windowsTotal: 10,
    windowsPositive: 7,
    windowPositiveShare: 0.7,
    symbolsTotal: 10,
    symbolsPositive: 8,
    symbolPositiveShare: 0.8,
    benchmarkWindows: 8,
    randomEntryP: 0.01,
    trials: 1,
    deflatedSharpe: {
      observedSharpe: 0.4,
      benchmarkSharpe: 0.05,
      probability: 0.97,
      radicand: 0.9,
      varianceOfTrialSharpes: 0,
    },
    plateau: null,
    stressTrades: 100,
    stressExpectancyPercent: 0.5,
    perYear: [{ year: 2025, trades: 150, expectancyPercent: 1 }],
    ...overrides,
  };
}

describe('evaluateStrategyGates: gate order', () => {
  it('returns the eight gates in the fixed order', () => {
    const { gates } = evaluateStrategyGates(makeBasePooled(), '1h');
    expect(gates.map((g) => g.name)).toEqual([
      'sample',
      'expectancy',
      'windows',
      'symbols',
      'timing',
      'trials',
      'plateau',
      'stress',
    ]);
  });
});

describe('evaluateStrategyGates: passing baseline', () => {
  it('passes every gate and the overall pass flag when every threshold clears', () => {
    const { gates, pass } = evaluateStrategyGates(makeBasePooled(), '1h');
    expect(gates.every((g) => g.pass)).toBe(true);
    expect(pass).toBe(true);
  });
});

describe('evaluateStrategyGates: sample', () => {
  it('fails when n is below the interval threshold, using the 5m threshold for 5m', () => {
    const pooled = makeBasePooled({ n: 250 });
    const gate1h = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'sample')!;
    const gate5m = evaluateStrategyGates(pooled, '5m').gates.find((g) => g.name === 'sample')!;
    expect(gate1h.pass).toBe(true);
    expect(gate1h.threshold).toBe(100);
    expect(gate5m.pass).toBe(false);
    expect(gate5m.threshold).toBe(300);
  });
});

describe('evaluateStrategyGates: expectancy', () => {
  it('fails when the CI low bound is at or below 0 even with a positive point estimate', () => {
    const pooled = makeBasePooled({ expectancyPercent: 1, bootstrapCi95: [-0.1, 2] });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'expectancy')!;
    expect(gate.pass).toBe(false);
    expect(gate.value).toBe(-0.1);
    expect(gate.note).toMatch(/point estimate/);
  });

  it('fails when bootstrapCi95 is null', () => {
    const pooled = makeBasePooled({ bootstrapCi95: null });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'expectancy')!;
    expect(gate.pass).toBe(false);
    expect(gate.value).toBeNull();
  });

  it('fails when the point estimate itself is not positive, even with a positive-looking CI low bound', () => {
    const pooled = makeBasePooled({ expectancyPercent: -0.5, bootstrapCi95: [0.1, 0.2] });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'expectancy')!;
    expect(gate.pass).toBe(false);
  });
});

describe('evaluateStrategyGates: windows and symbols', () => {
  it('fails windows below 0.6 and symbols below 0.7', () => {
    const pooled = makeBasePooled({ windowPositiveShare: 0.59, symbolPositiveShare: 0.69 });
    const { gates } = evaluateStrategyGates(pooled, '1h');
    expect(gates.find((g) => g.name === 'windows')!.pass).toBe(false);
    expect(gates.find((g) => g.name === 'symbols')!.pass).toBe(false);
  });

  it('passes at exactly the threshold', () => {
    const pooled = makeBasePooled({ windowPositiveShare: 0.6, symbolPositiveShare: 0.7 });
    const { gates } = evaluateStrategyGates(pooled, '1h');
    expect(gates.find((g) => g.name === 'windows')!.pass).toBe(true);
    expect(gates.find((g) => g.name === 'symbols')!.pass).toBe(true);
  });
});

describe('evaluateStrategyGates: timing', () => {
  it('fails and notes when randomEntryP is null', () => {
    const pooled = makeBasePooled({ randomEntryP: null, benchmarkWindows: 0 });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'timing')!;
    expect(gate.pass).toBe(false);
    expect(gate.note).toMatch(/benchmark disabled or no window had one/);
  });

  it('fails when randomEntryP is at or above the threshold', () => {
    const pooled = makeBasePooled({ randomEntryP: 0.05 });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'timing')!;
    expect(gate.pass).toBe(false);
  });
});

describe('evaluateStrategyGates: trials', () => {
  it('fails with "fewer than two trades" when deflatedSharpe is null', () => {
    const pooled = makeBasePooled({ deflatedSharpe: null });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'trials')!;
    expect(gate.pass).toBe(false);
    expect(gate.value).toBeNull();
    expect(gate.note).toBe('fewer than two trades');
  });

  it('fails with "moments outside the PSR domain" when the radicand is non-positive', () => {
    // Direct PooledStats construction: see the header comment above this
    // describe block for why a non-positive radicand cannot arise from real
    // pooled trade data through poolStrategyResults.
    const pooled = makeBasePooled({
      deflatedSharpe: {
        observedSharpe: 0.3,
        benchmarkSharpe: 0.1,
        probability: null,
        radicand: -0.0001,
        varianceOfTrialSharpes: 0,
      },
    });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'trials')!;
    expect(gate.pass).toBe(false);
    expect(gate.value).toBeNull();
    expect(gate.note).toBe('moments outside the PSR domain');
  });

  it('fails when probability is below 0.95 and passes at or above it', () => {
    const below = makeBasePooled({ deflatedSharpe: { observedSharpe: 0.2, benchmarkSharpe: 0.1, probability: 0.94, radicand: 0.5, varianceOfTrialSharpes: 0 } });
    const at = makeBasePooled({ deflatedSharpe: { observedSharpe: 0.2, benchmarkSharpe: 0.1, probability: 0.95, radicand: 0.5, varianceOfTrialSharpes: 0 } });
    expect(evaluateStrategyGates(below, '1h').gates.find((g) => g.name === 'trials')!.pass).toBe(false);
    expect(evaluateStrategyGates(at, '1h').gates.find((g) => g.name === 'trials')!.pass).toBe(true);
  });
});

describe('evaluateStrategyGates: plateau', () => {
  it('passes with a note when plateau is null (single cell)', () => {
    const pooled = makeBasePooled({ plateau: null });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'plateau')!;
    expect(gate.pass).toBe(true);
    expect(gate.note).toBe('single cell, not applicable');
  });

  it('fails with a note when the plateau score is null (best cell non-positive)', () => {
    const pooled = makeBasePooled({
      plateau: { score: null, neighbors: 0, bestMetric: -1, bestParams: { x: 1 }, neighborRadius: 0.5 },
    });
    const gate = evaluateStrategyGates(pooled, '1h').gates.find((g) => g.name === 'plateau')!;
    expect(gate.pass).toBe(false);
    expect(gate.note).toBe('best cell has non-positive expectancy');
  });

  it('fails below 0.6 and passes at or above it', () => {
    const below = makeBasePooled({ plateau: { score: 0.59, neighbors: 1, bestMetric: 1, bestParams: {}, neighborRadius: 0.5 } });
    const at = makeBasePooled({ plateau: { score: 0.6, neighbors: 1, bestMetric: 1, bestParams: {}, neighborRadius: 0.5 } });
    expect(evaluateStrategyGates(below, '1h').gates.find((g) => g.name === 'plateau')!.pass).toBe(false);
    expect(evaluateStrategyGates(at, '1h').gates.find((g) => g.name === 'plateau')!.pass).toBe(true);
  });
});

describe('evaluateStrategyGates: stress', () => {
  it('fails when stressExpectancyPercent is null or not positive', () => {
    expect(
      evaluateStrategyGates(makeBasePooled({ stressExpectancyPercent: null }), '1h').gates.find((g) => g.name === 'stress')!.pass
    ).toBe(false);
    expect(
      evaluateStrategyGates(makeBasePooled({ stressExpectancyPercent: 0 }), '1h').gates.find((g) => g.name === 'stress')!.pass
    ).toBe(false);
    expect(
      evaluateStrategyGates(makeBasePooled({ stressExpectancyPercent: 0.01 }), '1h').gates.find((g) => g.name === 'stress')!.pass
    ).toBe(true);
  });
});

describe('evaluateStrategyGates: overall pass', () => {
  it('is false when any single gate fails', () => {
    const pooled = makeBasePooled({ stressExpectancyPercent: -1 });
    const { pass, gates } = evaluateStrategyGates(pooled, '1h');
    expect(gates.filter((g) => !g.pass)).toHaveLength(1);
    expect(pass).toBe(false);
  });
});
