// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  controlLimitFamily,
  expandGrid,
  oscillatorReversionLimitFamily,
  returnReversalLimitFamily,
  STRATEGY_FAMILIES,
  withLimitEntry,
} from './strategy-families';
import { runStrategyWalkForward, type StrategyWalkForwardInput } from './strategy-walk-forward';
import { prepareBacktest, runOptimizedBacktest } from '@/lib/backtest/optimized-engine';
import { deriveVolatilityStops } from '@/lib/optimization/walk-forward';
import { DEFAULT_TEMPLATE_THRESHOLDS, DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { OpenPosition } from '@/lib/backtest/trade-utils';
import { DEFAULT_BACKTEST_CONFIG, type BacktestConfig } from '@/lib/backtest/types';
import type { OHLCV } from '@/types/market';

const BASE = 1700000000000;
const HOUR = 60 * 60 * 1000;

function makeCandle(close: number, bar = 0): OHLCV {
  return { timestamp: BASE + bar * HOUR, open: close, high: close, low: close, close, volume: 1000 };
}

/** A full IndicatorSuite with neutral defaults everywhere except the fields
 * the wrapped families actually read (atr, rsi); copied from
 * strategy-families-phase4.test.ts's own makeSuite so this file stays
 * self-contained. */
function makeSuite(overrides: Partial<IndicatorSuite> = {}): IndicatorSuite {
  return {
    ema12: { period: 12, values: [], current: 100 },
    ema26: { period: 26, values: [], current: 100 },
    sma50: { period: 50, values: [], current: 100 },
    sma200: { period: 200, values: [], current: 100 },
    rsi: { period: 14, values: [], current: 50 },
    macd: { values: [], current: { MACD: 0, signal: 0, histogram: 0 } },
    bollingerBands: { values: [], current: { upper: 110, middle: 100, lower: 90, pb: 0.5 } },
    atr: { period: 14, values: [], current: 5 },
    stochasticRSI: { values: [], current: { stochRSI: 0.5, k: 50, d: 50 } },
    williamsR: { period: 14, values: [], current: -50 },
    ichimoku: null,
    obv: { values: [], current: 0, sma20: 0 },
    mfi: { period: 14, values: [], current: 50 },
    volumeAnalysis: { currentVolume: 1000, sma20Volume: 1000, ratio: 1, priceChangePercent: 0 },
    signals: { trend: [], momentum: [], volatility: [], volume: [] },
    symbol: 'BTCUSDT',
    interval: '1h',
    candleCount: 0,
    lastCandleTime: BASE,
    ...overrides,
  };
}

function atrOf(current: number): IndicatorSuite['atr'] {
  return { period: 14, values: [], current };
}

function rsiOf(current: number): IndicatorSuite['rsi'] {
  return { period: 14, values: [], current };
}

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    bar: 0,
    candles: [makeCandle(100)],
    interval: '1h',
    suite: makeSuite(),
    score: 0,
    tier: 'neutral',
    superTrend: null,
    snapshot: null,
    htfContext: null,
    session: null,
    position: null,
    pendingOrder: null,
    ...overrides,
  };
}

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    entryBar: 0,
    entryTime: BASE,
    entryPrice: 100,
    side: 'long',
    quantity: 1,
    entryScore: 0,
    entryTier: 'neutral',
    stopPrice: 95,
    targetPrice: 105,
    timeStopBars: null,
    entrySlippageCost: 0,
    ...overrides,
  };
}

const CONFIG: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, allowShorts: true };
const STYLE_CTX = { style: 'day_trading' as const, interval: '1h' };

// Deterministic random walk with trend, seeded LCG (copied from
// strategy-walk-forward.test.ts / strategy-families-phase4.test.ts's
// generateCandles).
function generateCandles(count: number, seed = 123): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const drift = i < count / 2 ? 0.002 : -0.002;
    const noise = (nextRandom() - 0.5) * 0.5;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.005);
    const low = price * (1 - nextRandom() * 0.005);
    const open = price * (1 + (nextRandom() - 0.5) * 0.003);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
      takerBuyVolume: volume * (0.3 + nextRandom() * 0.4),
    });
  }

  return candles;
}

/** Asserts a strategy's decideEntry/decideExit at `bar` are unchanged when
 * `candles` is truncated to `bar + 1` elements (copied from
 * strategy-families-phase4.test.ts's own assertCausal). */
function assertCausal(strategy: Strategy, bar: number, buildCtx: (candles: OHLCV[]) => StrategyContext): void {
  const fullCandles = generateCandles(bar + 60);
  const truncatedCandles = fullCandles.slice(0, bar + 1);

  const fullCtx = buildCtx(fullCandles);
  const truncatedCtx = buildCtx(truncatedCandles);

  const fullDecision = strategy.decideEntry(fullCtx, CONFIG);
  expect(fullDecision).not.toBeNull();
  expect(strategy.decideEntry(truncatedCtx, CONFIG)).toEqual(fullDecision);

  const fullExitCtx = { ...fullCtx, position: makePosition({ side: 'long' }) };
  const truncatedExitCtx = { ...truncatedCtx, position: makePosition({ side: 'long' }) };
  expect(strategy.decideExit(truncatedExitCtx, CONFIG)).toBe(strategy.decideExit(fullExitCtx, CONFIG));
}

/** Independent cartesian-product builder (not the module under test's own
 * expandGrid) so the grid-order assertions below cross-check the exact
 * declared values against expandGrid's real output, rather than restating
 * expandGrid's own logic on the same data. */
function cartesian(paramValues: Array<[string, number[]]>): Record<string, number>[] {
  let cells: Record<string, number>[] = [{}];
  for (const [name, values] of paramValues) {
    const next: Record<string, number>[] = [];
    for (const cell of cells) {
      for (const value of values) next.push({ ...cell, [name]: value });
    }
    cells = next;
  }
  return cells;
}

describe('withLimitEntry', () => {
  const baseLong: EntryDecision = {
    side: 'long',
    orderType: 'market',
    stopPrice: 95,
    targetPrice: 110,
    timeStopBars: 12,
  };
  const baseShort: EntryDecision = {
    side: 'short',
    orderType: 'market',
    stopPrice: 105,
    targetPrice: 90,
    timeStopBars: 12,
  };

  it('converts a market long decision into a limit order at the offset below the close', () => {
    const base: Strategy = { name: 'base', decideEntry: () => baseLong, decideExit: () => false };
    const wrapped = withLimitEntry(base, 'wrapped', { a: 1 }, { timeoutBars: 2, offsetBps: 5 });
    const ctx = makeContext({ candles: [makeCandle(100)] });

    const decision = wrapped.decideEntry(ctx, CONFIG);
    expect(decision).toEqual({
      side: 'long',
      orderType: 'limit',
      limitPrice: 100 * (1 - 5 / 10000),
      timeoutBars: 2,
      stopPrice: 95,
      targetPrice: 110,
      timeStopBars: 12,
    });
  });

  it('converts a market short decision into a limit order at the offset above the close', () => {
    const base: Strategy = { name: 'base', decideEntry: () => baseShort, decideExit: () => false };
    const wrapped = withLimitEntry(base, 'wrapped', { a: 1 }, { timeoutBars: 3, offsetBps: 10 });
    const ctx = makeContext({ candles: [makeCandle(200)] });

    const decision = wrapped.decideEntry(ctx, CONFIG);
    expect(decision).toEqual({
      side: 'short',
      orderType: 'limit',
      limitPrice: 200 * (1 + 10 / 10000),
      timeoutBars: 3,
      stopPrice: 105,
      targetPrice: 90,
      timeStopBars: 12,
    });
  });

  it('computes limitPrice to 1e-9 for both sides', () => {
    const close = 137.42;
    const offsetBps = 7.5;
    const longBase: Strategy = { name: 'base', decideEntry: () => baseLong, decideExit: () => false };
    const shortBase: Strategy = { name: 'base', decideEntry: () => baseShort, decideExit: () => false };
    const ctx = makeContext({ candles: [makeCandle(close)] });

    const longWrapped = withLimitEntry(longBase, 'w', {}, { timeoutBars: 1, offsetBps });
    const longDecision = longWrapped.decideEntry(ctx, CONFIG);
    expect(longDecision!.limitPrice).toBeCloseTo(close * (1 - offsetBps / 10000), 9);

    const shortWrapped = withLimitEntry(shortBase, 'w', {}, { timeoutBars: 1, offsetBps });
    const shortDecision = shortWrapped.decideEntry(ctx, CONFIG);
    expect(shortDecision!.limitPrice).toBeCloseTo(close * (1 + offsetBps / 10000), 9);
  });

  it('returns null when the base strategy returns null', () => {
    const base: Strategy = { name: 'base', decideEntry: () => null, decideExit: () => false };
    const wrapped = withLimitEntry(base, 'wrapped', {}, { timeoutBars: 1, offsetBps: 0 });
    expect(wrapped.decideEntry(makeContext(), CONFIG)).toBeNull();
  });

  it('returns null when the current close is not finite', () => {
    const base: Strategy = { name: 'base', decideEntry: () => baseLong, decideExit: () => false };
    const wrapped = withLimitEntry(base, 'wrapped', {}, { timeoutBars: 1, offsetBps: 0 });
    const ctx = makeContext({ candles: [makeCandle(NaN)] });
    expect(wrapped.decideEntry(ctx, CONFIG)).toBeNull();
  });

  it('decideExit delegates to the base strategy', () => {
    const decideExit = vi.fn(() => true);
    const base: Strategy = { name: 'base', decideEntry: () => null, decideExit };
    const wrapped = withLimitEntry(base, 'wrapped', {}, { timeoutBars: 1, offsetBps: 0 });
    const ctx = makeContext({ position: makePosition() });

    expect(wrapped.decideExit(ctx, CONFIG)).toBe(true);
    expect(decideExit).toHaveBeenCalledWith(ctx, CONFIG);
  });

  it('uses the given name and params', () => {
    const base: Strategy = { name: 'base', decideEntry: () => null, decideExit: () => false };
    const params = { timeout: 2, offsetBps: 5 };
    const wrapped = withLimitEntry(base, 'my-wrapped-name', params, { timeoutBars: 2, offsetBps: 5 });
    expect(wrapped.name).toBe('my-wrapped-name');
    expect(wrapped.params).toBe(params);
  });
});

describe('registry', () => {
  it('STRATEGY_FAMILIES has eight names', () => {
    expect(Object.keys(STRATEGY_FAMILIES).sort()).toEqual(
      [
        'control',
        'control-limit',
        'fade-composite',
        'oscillator-reversion',
        'oscillator-reversion-limit',
        'return-reversal',
        'return-reversal-limit',
        'stochrsi-momentum',
      ].sort()
    );
  });

  it('control-limit: timeout [1,2,3] x offsetBps [0,5,10,20,30], 15 cells in declared order', () => {
    const expected = cartesian([
      ['timeout', [1, 2, 3]],
      ['offsetBps', [0, 5, 10, 20, 30]],
    ]);
    expect(expected).toHaveLength(15);
    expect(expandGrid(controlLimitFamily)).toEqual(expected);
  });

  it('return-reversal-limit: L [5,20] x Z [2,2.5] x H [8,16] x timeout [1,2], 16 cells in declared order', () => {
    const expected = cartesian([
      ['L', [5, 20]],
      ['Z', [2, 2.5]],
      ['H', [8, 16]],
      ['timeout', [1, 2]],
    ]);
    expect(expected).toHaveLength(16);
    expect(expandGrid(returnReversalLimitFamily)).toEqual(expected);
    // Most-selected Phase 4 cells stay inside the reduced grid (any timeout).
    expect(expected).toContainEqual({ L: 20, Z: 2.5, H: 16, timeout: 1 });
    expect(expected).toContainEqual({ L: 20, Z: 2, H: 16, timeout: 1 });
  });

  it('oscillator-reversion-limit: R [25,30] x H [16,32] x band [0,1] x timeout [1,2], 16 cells in declared order', () => {
    const expected = cartesian([
      ['R', [25, 30]],
      ['H', [16, 32]],
      ['band', [0, 1]],
      ['timeout', [1, 2]],
    ]);
    expect(expected).toHaveLength(16);
    expect(expandGrid(oscillatorReversionLimitFamily)).toEqual(expected);
    // Most-selected Phase 4 cells stay inside the reduced grid (any timeout).
    expect(expected).toContainEqual({ R: 25, H: 32, band: 1, timeout: 1 });
    expect(expected).toContainEqual({ R: 25, H: 16, band: 1, timeout: 1 });
  });
});

describe('control-limit', () => {
  const cell = { timeout: 2, offsetBps: 5 };
  const strategy = controlLimitFamily.create(cell, STYLE_CTX);

  it('enters a limit long at the offset below the close on a buy score, control stop/target', () => {
    const close = 100;
    const ctx = makeContext({ score: 50, candles: [makeCandle(close)] });
    const decision = strategy.decideEntry(ctx, CONFIG);
    expect(decision).toEqual({
      side: 'long',
      orderType: 'limit',
      limitPrice: close * (1 - 5 / 10000),
      timeoutBars: 2,
      stopPrice: close * (1 - CONFIG.stopLossPercent),
      targetPrice: close * (1 + CONFIG.takeProfitPercent),
      timeStopBars: null,
    });
  });

  it('enters a limit short above the close on a sell score, with allowShorts', () => {
    const close = 100;
    const ctx = makeContext({ score: -50, candles: [makeCandle(close)] });
    const decision = strategy.decideEntry(ctx, CONFIG);
    expect(decision).toEqual({
      side: 'short',
      orderType: 'limit',
      limitPrice: close * (1 + 5 / 10000),
      timeoutBars: 2,
      stopPrice: close * (1 + CONFIG.stopLossPercent),
      targetPrice: close * (1 - CONFIG.takeProfitPercent),
      timeStopBars: null,
    });
  });

  it('returns null on a neutral score', () => {
    const ctx = makeContext({ score: 0, candles: [makeCandle(100)] });
    expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
  });
});

describe('return-reversal-limit', () => {
  it('enters a limit long at the close (offsetBps 0) when the wrapped rule fires; exit rule unchanged', () => {
    const L = 5;
    // |z| = sqrt(20 / L) exactly for this single-step-return fixture (see
    // strategy-families-phase4.test.ts's lastStepCandles derivation, which
    // this generalizes from L=1 to any L: vol20 depends only on the last 20
    // bars' returns, not on L, so z = R / (vol20 * sqrt(L)) reduces to
    // sign(R) * sqrt(20 / L) regardless of R's magnitude).
    const zMagnitude = Math.sqrt(20 / L);
    const cell = { L, Z: zMagnitude - 1e-6, H: 8, timeout: 1 };
    const strategy = returnReversalLimitFamily.create(cell, STYLE_CTX);

    const closes = new Array(25).fill(100);
    closes[24] = closes[23] * Math.exp(-0.03); // a known drop -> z <= -Z, longs
    const candles = closes.map((close, bar) => makeCandle(close, bar));
    const ctx = makeContext({ bar: 24, candles, suite: makeSuite({ atr: atrOf(5) }) });

    const decision = strategy.decideEntry(ctx, CONFIG);
    expect(decision).toEqual({
      side: 'long',
      orderType: 'limit',
      limitPrice: candles[24].close,
      timeoutBars: 1,
      stopPrice: candles[24].close - 2 * 5,
      targetPrice: null,
      timeStopBars: 8,
    });

    // decideExit delegates to return-reversal's own rule, which is always false.
    const exitCtx = { ...ctx, position: makePosition({ side: 'long' }) };
    expect(strategy.decideExit(exitCtx, CONFIG)).toBe(false);
  });
});

describe('oscillator-reversion-limit', () => {
  const cell = { R: 30, H: 16, band: 0, timeout: 2 };
  const strategy = oscillatorReversionLimitFamily.create(cell, STYLE_CTX);

  it('enters a limit long at the close (offsetBps 0) when the wrapped rule fires', () => {
    const close = 100;
    const ctx = makeContext({ candles: [makeCandle(close)], suite: makeSuite({ rsi: rsiOf(30), atr: atrOf(5) }) });
    const decision = strategy.decideEntry(ctx, CONFIG);
    expect(decision).toEqual({
      side: 'long',
      orderType: 'limit',
      limitPrice: close,
      timeoutBars: 2,
      stopPrice: close - 2 * 5,
      targetPrice: null,
      timeStopBars: 16,
    });
  });

  it('the wrapped exit rule still applies: exits a long once rsi reaches 50', () => {
    const exitTrueCtx = makeContext({
      suite: makeSuite({ rsi: rsiOf(50) }),
      position: makePosition({ side: 'long' }),
    });
    expect(strategy.decideExit(exitTrueCtx, CONFIG)).toBe(true);

    const exitFalseCtx = makeContext({
      suite: makeSuite({ rsi: rsiOf(49.999999) }),
      position: makePosition({ side: 'long' }),
    });
    expect(strategy.decideExit(exitFalseCtx, CONFIG)).toBe(false);
  });
});

describe('causality', () => {
  it('control-limit: same decision when candles is truncated to bar + 1', () => {
    const strategy = controlLimitFamily.create({ timeout: 2, offsetBps: 5 }, STYLE_CTX);
    assertCausal(strategy, 40, (candles) => makeContext({ bar: 40, candles, score: 50 }));
  });

  it('return-reversal-limit: same decision when candles is truncated to bar + 1', () => {
    const strategy = returnReversalLimitFamily.create({ L: 5, Z: 0.0001, H: 8, timeout: 1 }, STYLE_CTX);
    assertCausal(strategy, 40, (candles) => makeContext({ bar: 40, candles, suite: makeSuite({ atr: atrOf(4) }) }));
  });

  it('oscillator-reversion-limit: same decision when candles is truncated to bar + 1', () => {
    const strategy = oscillatorReversionLimitFamily.create({ R: 30, H: 16, band: 0, timeout: 1 }, STYLE_CTX);
    assertCausal(strategy, 40, (candles) =>
      makeContext({ bar: 40, candles, suite: makeSuite({ rsi: rsiOf(10), atr: atrOf(4) }) })
    );
  });
});

describe('engine integration: control-limit', () => {
  const SYMBOL = 'BTCUSDT';
  const INTERVAL = '1h';
  const STYLE = 'day_trading' as const;
  const COSTS = { feePercent: 0.0005, makerFeePercent: 0.0002, takerFeePercent: 0.0005, slippageBps: 3 };
  const STRESS = { feeMultiplier: 1.5, slippageMultiplier: 1.5 };
  const WINDOWS = { count: 2, trainFraction: 0.4, mode: 'anchored' as const };
  // control-limit only enters where the composite score crosses control's own
  // calibrated thresholds (TIER_BUY_CUTOFF magnitude 24), which the default
  // generateCandles(1200) seed rarely reaches inside either out-of-sample
  // test window; seed 12 does (verified empirically), without changing the
  // walk shape or drift used elsewhere in this file.
  const randomWalk = generateCandles(1200, 12);

  it('runs the full grid through runStrategyWalkForward and produces an out-of-sample trade', () => {
    const cells = expandGrid(controlLimitFamily);
    const input: StrategyWalkForwardInput = {
      candles: randomWalk,
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family: controlLimitFamily,
      cells,
      costs: COSTS,
      fundingEnabled: false,
      windows: WINDOWS,
      minIsTrades: 1,
      stress: STRESS,
      benchmark: null,
    };

    const result = runStrategyWalkForward(input);
    expect(result.windows).toHaveLength(WINDOWS.count);

    let anyOosTrade = false;
    for (const window of result.windows) {
      expect(window.oosCells).toHaveLength(cells.length);
      for (const cell of window.oosCells) {
        if (cell.trades > 0) anyOosTrade = true;
      }
    }
    expect(anyOosTrade).toBe(true);
  });

  // strategy-walk-forward.ts's OosTrade carries no entryFillKind field, so
  // confirming maker fills needs a direct engine run instead of reading it
  // off the walk-forward's own output: one control-limit grid cell through
  // prepareBacktest/runOptimizedBacktest on the same random walk, with a
  // config built the same way runStrategyWalkForward builds its own
  // (day_trading thresholds/weights, the same study-like costs).
  it('every trade from a direct prepareBacktest/runOptimizedBacktest run fills at the maker rate', () => {
    const cell = expandGrid(controlLimitFamily)[0];
    const strategy = controlLimitFamily.create(cell, { style: STYLE, interval: INTERVAL });

    const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[STYLE];
    const weights = DEFAULT_TEMPLATE_WEIGHTS[STYLE];
    const stops = deriveVolatilityStops(randomWalk, COSTS.takerFeePercent);
    const config: BacktestConfig = {
      entryThreshold: thresholds.entryThreshold,
      exitThreshold: thresholds.exitThreshold,
      shortEntryThreshold: thresholds.shortEntryThreshold,
      shortExitThreshold: thresholds.shortExitThreshold,
      weights,
      allowShorts: true,
      positionSizePercent: 0.1,
      stopLossPercent: stops.stopLossPercent,
      takeProfitPercent: stops.takeProfitPercent,
      feePercent: COSTS.feePercent,
      makerFeePercent: COSTS.makerFeePercent,
      takerFeePercent: COSTS.takerFeePercent,
      slippageBps: COSTS.slippageBps,
      startEquity: 10000,
    };

    const prepared = prepareBacktest(randomWalk, SYMBOL, INTERVAL);
    const result = runOptimizedBacktest(prepared, config, SYMBOL, INTERVAL, undefined, strategy);

    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.every((t) => t.entryFillKind === 'maker')).toBe(true);
  });
});
