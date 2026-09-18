// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  expandGrid,
  fadeCompositeFamily,
  oscillatorReversionFamily,
  returnReversalFamily,
  stochrsiMomentumFamily,
} from './strategy-families';
import { runStrategyWalkForward, type StrategyWalkForwardInput } from './strategy-walk-forward';
import { STRATEGY_EXIT_LEVEL } from '@/lib/signals/calibration';
import type { Strategy, StrategyContext } from '@/lib/backtest/strategy';
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
 * the phase 4 families actually read (atr, rsi, bollingerBands,
 * stochasticRSI, williamsR); tests override only what they need. */
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

function stochOf(k: number, d: number): IndicatorSuite['stochasticRSI'] {
  return { values: [], current: { stochRSI: 0.5, k, d } };
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
// strategy-walk-forward.test.ts's generateCandles).
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

/** A candles array sharp-dropping for `dropBars` bars starting at `dropAt`,
 * flat before and after; used only where the plain random walk does not
 * produce enough movement to exercise a reversal family. */
function sharpDropCandles(count: number, dropAt: number, dropBars: number, dropPercent: number): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  const perBarDrop = dropPercent / dropBars;
  for (let i = 0; i < count; i++) {
    if (i >= dropAt && i < dropAt + dropBars) {
      price = price * (1 - perBarDrop);
    }
    candles.push(makeCandle(price, i));
  }
  return candles;
}

/** Asserts a strategy's decideEntry/decideExit at `bar` are unchanged when
 * `candles` is truncated to `bar + 1` elements: the causality contract every
 * family must hold (never read ctx.candles past ctx.bar). `buildCtx` gets
 * the full or truncated candle array and must place the same bar/suite/score
 * in the returned context either way. */
function assertCausal(strategy: Strategy, bar: number, buildCtx: (candles: OHLCV[]) => StrategyContext): void {
  const fullCandles = generateCandles(bar + 60);
  const truncatedCandles = fullCandles.slice(0, bar + 1);

  const fullCtx = buildCtx(fullCandles);
  const truncatedCtx = buildCtx(truncatedCandles);

  expect(strategy.decideEntry(truncatedCtx, CONFIG)).toEqual(strategy.decideEntry(fullCtx, CONFIG));

  const fullExitCtx = { ...fullCtx, position: makePosition({ side: 'long' }) };
  const truncatedExitCtx = { ...truncatedCtx, position: makePosition({ side: 'long' }) };
  expect(strategy.decideExit(truncatedExitCtx, CONFIG)).toBe(strategy.decideExit(fullExitCtx, CONFIG));
}

describe('fade-composite', () => {
  const strategy = fadeCompositeFamily.create({ T: 24, timeStop: 16, k: 2 }, STYLE_CTX);

  describe('decideEntry', () => {
    it('shorts when score meets T', () => {
      const ctx = makeContext({ score: 24, candles: [makeCandle(100)], suite: makeSuite({ atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toEqual({
        side: 'short',
        orderType: 'market',
        stopPrice: 110,
        targetPrice: 80,
        timeStopBars: 16,
      });
    });

    it('does not short just below T', () => {
      const ctx = makeContext({ score: 23.999999, suite: makeSuite({ atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('longs when score meets -T', () => {
      const ctx = makeContext({ score: -24, candles: [makeCandle(100)], suite: makeSuite({ atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toEqual({
        side: 'long',
        orderType: 'market',
        stopPrice: 90,
        targetPrice: 120,
        timeStopBars: 16,
      });
    });

    it('does not long just above -T', () => {
      const ctx = makeContext({ score: -23.999999, suite: makeSuite({ atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('computes the stop and target to 1e-9 from close, atr, and k', () => {
      const close = 137.42;
      const atr = 3.17;
      const ctx = makeContext({ score: 24, candles: [makeCandle(close)], suite: makeSuite({ atr: atrOf(atr) }) });
      const decision = strategy.decideEntry(ctx, CONFIG);
      expect(decision).not.toBeNull();
      expect(decision!.stopPrice).toBeCloseTo(close + 2 * atr, 9);
      expect(decision!.targetPrice!).toBeCloseTo(close - 2 * 2 * atr, 9);
    });

    it('returns null when suite is null (pre-warmup)', () => {
      const ctx = makeContext({ score: 50, suite: null });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when atr is not finite', () => {
      const ctx = makeContext({ score: 50, suite: makeSuite({ atr: atrOf(NaN) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when atr is not above 0', () => {
      const ctx = makeContext({ score: 50, suite: makeSuite({ atr: atrOf(0) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when score is not finite', () => {
      const ctx = makeContext({ score: NaN, suite: makeSuite({ atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });
  });

  describe('decideExit', () => {
    it('exits a short at STRATEGY_EXIT_LEVEL', () => {
      const ctx = makeContext({ score: STRATEGY_EXIT_LEVEL, position: makePosition({ side: 'short' }) });
      expect(strategy.decideExit(ctx, CONFIG)).toBe(true);
    });

    it('does not exit a short just above STRATEGY_EXIT_LEVEL', () => {
      const ctx = makeContext({ score: STRATEGY_EXIT_LEVEL + 0.000001, position: makePosition({ side: 'short' }) });
      expect(strategy.decideExit(ctx, CONFIG)).toBe(false);
    });

    it('exits a long at -STRATEGY_EXIT_LEVEL', () => {
      const ctx = makeContext({ score: -STRATEGY_EXIT_LEVEL, position: makePosition({ side: 'long' }) });
      expect(strategy.decideExit(ctx, CONFIG)).toBe(true);
    });

    it('does not exit a long just below -STRATEGY_EXIT_LEVEL', () => {
      const ctx = makeContext({ score: -STRATEGY_EXIT_LEVEL - 0.000001, position: makePosition({ side: 'long' }) });
      expect(strategy.decideExit(ctx, CONFIG)).toBe(false);
    });

    it('returns false when there is no position', () => {
      const ctx = makeContext({ score: 0, position: null });
      expect(strategy.decideExit(ctx, CONFIG)).toBe(false);
    });
  });

  it('is causal: same decision when candles is truncated to bar + 1', () => {
    assertCausal(strategy, 40, (candles) =>
      makeContext({ bar: 40, candles, score: 50, suite: makeSuite({ atr: atrOf(4) }) })
    );
  });
});

describe('return-reversal', () => {
  const strategy = returnReversalFamily.create({ L: 1, Z: 2, H: 8 }, STYLE_CTX);

  /** L=1 sample: 25 flat closes except the final step, which moves by an
   * arbitrary log return R. The 20-return vol20 window (bars 5..24) then
   * holds 19 zero returns and this one R return, so mean = R/20 and
   * variance = R^2 * (19*(19/20)^2 + (1/20)^2) / 19 = R^2 * 0.05 exactly --
   * independent of R's magnitude or sign. vol20 = |R| * sqrt(0.05), and
   * z = R / (vol20 * sqrt(1)) = sign(R) / sqrt(0.05) = sign(R) * sqrt(20),
   * so z is a known constant (+-4.47213595499958) regardless of R. Verified
   * numerically before writing this fixture (25 closes, L=1, R=0.01/0.05/
   * -0.02 all gave |z| = sqrt(20) to float precision).
   */
  function lastStepCandles(R: number): OHLCV[] {
    const closes = new Array(25).fill(100);
    closes[24] = closes[23] * Math.exp(R);
    return closes.map((close, bar) => makeCandle(close, bar));
  }

  const Z_MAGNITUDE = Math.sqrt(20);

  describe('decideEntry: z boundary (hand-computed, L=1)', () => {
    it('shorts when z (a known rise) is at or above Z', () => {
      const testStrategy = returnReversalFamily.create({ L: 1, Z: Z_MAGNITUDE - 1e-6, H: 8 }, STYLE_CTX);
      const candles = lastStepCandles(0.03);
      const ctx = makeContext({ bar: 24, candles, suite: makeSuite({ atr: atrOf(5) }) });
      const decision = testStrategy.decideEntry(ctx, CONFIG);
      expect(decision).not.toBeNull();
      expect(decision!.side).toBe('short');
      expect(decision!.stopPrice).toBeCloseTo(candles[24].close + 2 * 5, 9);
      expect(decision!.targetPrice).toBeNull();
      expect(decision!.timeStopBars).toBe(8);
    });

    it('does not short when z is just below Z', () => {
      const testStrategy = returnReversalFamily.create({ L: 1, Z: Z_MAGNITUDE + 1e-6, H: 8 }, STYLE_CTX);
      const candles = lastStepCandles(0.03);
      const ctx = makeContext({ bar: 24, candles, suite: makeSuite({ atr: atrOf(5) }) });
      expect(testStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('longs when z (a known drop) is at or below -Z', () => {
      const testStrategy = returnReversalFamily.create({ L: 1, Z: Z_MAGNITUDE - 1e-6, H: 8 }, STYLE_CTX);
      const candles = lastStepCandles(-0.03);
      const ctx = makeContext({ bar: 24, candles, suite: makeSuite({ atr: atrOf(5) }) });
      const decision = testStrategy.decideEntry(ctx, CONFIG);
      expect(decision).not.toBeNull();
      expect(decision!.side).toBe('long');
      expect(decision!.stopPrice).toBeCloseTo(candles[24].close - 2 * 5, 9);
    });

    it('does not long when |z| is just below Z', () => {
      const testStrategy = returnReversalFamily.create({ L: 1, Z: Z_MAGNITUDE + 1e-6, H: 8 }, STYLE_CTX);
      const candles = lastStepCandles(-0.03);
      const ctx = makeContext({ bar: 24, candles, suite: makeSuite({ atr: atrOf(5) }) });
      expect(testStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });
  });

  describe('decideEntry: guards', () => {
    it('returns null when suite is null (pre-warmup)', () => {
      const candles = lastStepCandles(0.03);
      const ctx = makeContext({ bar: 24, candles, suite: null });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when atr is not finite', () => {
      const candles = lastStepCandles(0.03);
      const ctx = makeContext({ bar: 24, candles, suite: makeSuite({ atr: atrOf(NaN) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when bar is below max(L, 20)', () => {
      const highLStrategy = returnReversalFamily.create({ L: 20, Z: 1.5, H: 8 }, STYLE_CTX);
      const candles = generateCandles(30);
      const ctx = makeContext({ bar: 19, candles, suite: makeSuite({ atr: atrOf(5) }) });
      expect(highLStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when vol20 is 0 (flat closes)', () => {
      const flatCandles = Array.from({ length: 25 }, (_, bar) => makeCandle(100, bar));
      const ctx = makeContext({ bar: 24, candles: flatCandles, suite: makeSuite({ atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });
  });

  it('decideExit always returns false', () => {
    const ctx = makeContext({ position: makePosition({ side: 'long' }) });
    expect(strategy.decideExit(ctx, CONFIG)).toBe(false);
    const shortCtx = makeContext({ position: makePosition({ side: 'short' }) });
    expect(strategy.decideExit(shortCtx, CONFIG)).toBe(false);
  });

  it('is causal: same decision when candles is truncated to bar + 1', () => {
    const causalStrategy = returnReversalFamily.create({ L: 5, Z: 0.0001, H: 8 }, STYLE_CTX);
    assertCausal(causalStrategy, 40, (candles) =>
      makeContext({ bar: 40, candles, suite: makeSuite({ atr: atrOf(4) }) })
    );
  });
});

describe('oscillator-reversion', () => {
  const bandOffStrategy = oscillatorReversionFamily.create({ R: 30, H: 16, band: 0 }, STYLE_CTX);
  const bandOnStrategy = oscillatorReversionFamily.create({ R: 30, H: 16, band: 1 }, STYLE_CTX);

  describe('decideEntry: band 0 (RSI only)', () => {
    it('longs at rsi === R', () => {
      const ctx = makeContext({
        candles: [makeCandle(100)],
        suite: makeSuite({ rsi: rsiOf(30), atr: atrOf(5) }),
      });
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)).toEqual({
        side: 'long',
        orderType: 'market',
        stopPrice: 90,
        targetPrice: null,
        timeStopBars: 16,
      });
    });

    it('does not long just above R', () => {
      const ctx = makeContext({ suite: makeSuite({ rsi: rsiOf(30.000001), atr: atrOf(5) }) });
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('shorts at rsi === 100 - R', () => {
      const ctx = makeContext({
        candles: [makeCandle(100)],
        suite: makeSuite({ rsi: rsiOf(70), atr: atrOf(5) }),
      });
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)).toEqual({
        side: 'short',
        orderType: 'market',
        stopPrice: 110,
        targetPrice: null,
        timeStopBars: 16,
      });
    });

    it('does not short just below 100 - R', () => {
      const ctx = makeContext({ suite: makeSuite({ rsi: rsiOf(69.999999), atr: atrOf(5) }) });
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('fires regardless of the Bollinger band when band is 0', () => {
      const ctx = makeContext({
        candles: [makeCandle(100)],
        suite: makeSuite({
          rsi: rsiOf(30),
          atr: atrOf(5),
          bollingerBands: { values: [], current: { upper: 200, middle: 150, lower: 100.5, pb: 0 } },
        }),
      });
      // close (100) is below bb.lower (100.5) is irrelevant with band 0.
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)?.side).toBe('long');
    });
  });

  describe('decideEntry: band 1 (RSI gated by the Bollinger band)', () => {
    it('does not long when rsi qualifies but close is above bb.lower', () => {
      const ctx = makeContext({
        candles: [makeCandle(100)],
        suite: makeSuite({
          rsi: rsiOf(30),
          atr: atrOf(5),
          bollingerBands: { values: [], current: { upper: 110, middle: 100, lower: 90, pb: 0.5 } },
        }),
      });
      expect(bandOnStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('longs when rsi qualifies and close is at or below bb.lower', () => {
      const ctx = makeContext({
        candles: [makeCandle(89)],
        suite: makeSuite({
          rsi: rsiOf(30),
          atr: atrOf(5),
          bollingerBands: { values: [], current: { upper: 110, middle: 100, lower: 90, pb: 0.5 } },
        }),
      });
      expect(bandOnStrategy.decideEntry(ctx, CONFIG)?.side).toBe('long');
    });

    it('does not short when rsi qualifies but close is below bb.upper', () => {
      const ctx = makeContext({
        candles: [makeCandle(100)],
        suite: makeSuite({
          rsi: rsiOf(70),
          atr: atrOf(5),
          bollingerBands: { values: [], current: { upper: 110, middle: 100, lower: 90, pb: 0.5 } },
        }),
      });
      expect(bandOnStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('shorts when rsi qualifies and close is at or above bb.upper', () => {
      const ctx = makeContext({
        candles: [makeCandle(111)],
        suite: makeSuite({
          rsi: rsiOf(70),
          atr: atrOf(5),
          bollingerBands: { values: [], current: { upper: 110, middle: 100, lower: 90, pb: 0.5 } },
        }),
      });
      expect(bandOnStrategy.decideEntry(ctx, CONFIG)?.side).toBe('short');
    });
  });

  describe('decideEntry: guards', () => {
    it('returns null when suite is null (pre-warmup)', () => {
      const ctx = makeContext({ suite: null });
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when atr is not finite', () => {
      const ctx = makeContext({ suite: makeSuite({ rsi: rsiOf(30), atr: atrOf(NaN) }) });
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when rsi is not finite', () => {
      const ctx = makeContext({ suite: makeSuite({ rsi: rsiOf(NaN), atr: atrOf(5) }) });
      expect(bandOffStrategy.decideEntry(ctx, CONFIG)).toBeNull();
    });
  });

  describe('decideExit', () => {
    it('exits a long at rsi === 50', () => {
      const ctx = makeContext({ suite: makeSuite({ rsi: rsiOf(50) }), position: makePosition({ side: 'long' }) });
      expect(bandOffStrategy.decideExit(ctx, CONFIG)).toBe(true);
    });

    it('does not exit a long just below rsi 50', () => {
      const ctx = makeContext({
        suite: makeSuite({ rsi: rsiOf(49.999999) }),
        position: makePosition({ side: 'long' }),
      });
      expect(bandOffStrategy.decideExit(ctx, CONFIG)).toBe(false);
    });

    it('exits a short at rsi === 50', () => {
      const ctx = makeContext({ suite: makeSuite({ rsi: rsiOf(50) }), position: makePosition({ side: 'short' }) });
      expect(bandOffStrategy.decideExit(ctx, CONFIG)).toBe(true);
    });

    it('does not exit a short just above rsi 50', () => {
      const ctx = makeContext({
        suite: makeSuite({ rsi: rsiOf(50.000001) }),
        position: makePosition({ side: 'short' }),
      });
      expect(bandOffStrategy.decideExit(ctx, CONFIG)).toBe(false);
    });

    it('returns false when there is no position', () => {
      const ctx = makeContext({ suite: makeSuite({ rsi: rsiOf(50) }), position: null });
      expect(bandOffStrategy.decideExit(ctx, CONFIG)).toBe(false);
    });
  });

  it('is causal: same decision when candles is truncated to bar + 1', () => {
    assertCausal(bandOffStrategy, 40, (candles) =>
      makeContext({ bar: 40, candles, suite: makeSuite({ rsi: rsiOf(10), atr: atrOf(4) }) })
    );
  });
});

describe('stochrsi-momentum', () => {
  const strategy = stochrsiMomentumFamily.create({ zone: 30, hold: 3, k: 2 }, STYLE_CTX);

  describe('decideEntry', () => {
    it('longs when d is inside the zone and sk > d', () => {
      const ctx = makeContext({
        candles: [makeCandle(100)],
        suite: makeSuite({ stochasticRSI: stochOf(26, 25), atr: atrOf(5) }),
      });
      expect(strategy.decideEntry(ctx, CONFIG)).toEqual({
        side: 'long',
        orderType: 'market',
        stopPrice: 90,
        targetPrice: null,
        timeStopBars: 3,
      });
    });

    it('does not long when d is above the zone', () => {
      const ctx = makeContext({ suite: makeSuite({ stochasticRSI: stochOf(31, 30), atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('does not long when d is inside the zone but sk has not crossed above d', () => {
      const ctx = makeContext({ suite: makeSuite({ stochasticRSI: stochOf(25, 25), atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('shorts when d is above 100 - zone and sk < d (the mirror)', () => {
      const ctx = makeContext({
        candles: [makeCandle(100)],
        suite: makeSuite({ stochasticRSI: stochOf(74, 75), atr: atrOf(5) }),
      });
      expect(strategy.decideEntry(ctx, CONFIG)).toEqual({
        side: 'short',
        orderType: 'market',
        stopPrice: 110,
        targetPrice: null,
        timeStopBars: 3,
      });
    });

    it('does not short when d is below 100 - zone', () => {
      const ctx = makeContext({ suite: makeSuite({ stochasticRSI: stochOf(69, 70), atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('does not short when d is above 100 - zone but sk has not crossed below d', () => {
      const ctx = makeContext({ suite: makeSuite({ stochasticRSI: stochOf(75, 75), atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });
  });

  describe('decideEntry: guards', () => {
    it('returns null when suite is null (pre-warmup)', () => {
      const ctx = makeContext({ suite: null });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when atr is not finite', () => {
      const ctx = makeContext({ suite: makeSuite({ stochasticRSI: stochOf(26, 25), atr: atrOf(NaN) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });

    it('returns null when k or d is not finite', () => {
      const ctx = makeContext({ suite: makeSuite({ stochasticRSI: stochOf(NaN, 25), atr: atrOf(5) }) });
      expect(strategy.decideEntry(ctx, CONFIG)).toBeNull();
    });
  });

  it('decideExit always returns false', () => {
    const ctx = makeContext({ position: makePosition({ side: 'long' }) });
    expect(strategy.decideExit(ctx, CONFIG)).toBe(false);
    const shortCtx = makeContext({ position: makePosition({ side: 'short' }) });
    expect(strategy.decideExit(shortCtx, CONFIG)).toBe(false);
  });

  it('is causal: same decision when candles is truncated to bar + 1', () => {
    assertCausal(strategy, 40, (candles) =>
      makeContext({ bar: 40, candles, suite: makeSuite({ stochasticRSI: stochOf(26, 25), atr: atrOf(4) }) })
    );
  });
});

describe('integration: runStrategyWalkForward', () => {
  const SYMBOL = 'BTCUSDT';
  const INTERVAL = '1h';
  const STYLE = 'day_trading' as const;
  const COSTS = { feePercent: 0.0005, makerFeePercent: 0.0002, takerFeePercent: 0.0005, slippageBps: 3 };
  const STRESS = { feeMultiplier: 1.5, slippageMultiplier: 1.5 };
  const WINDOWS = { count: 2, trainFraction: 0.4, mode: 'anchored' as const };

  /** Runs one family's full grid through the harness and asserts it
   * completes, fills oosCells for every cell in every window, and produces
   * at least one out-of-sample trade somewhere across the run. */
  function runIntegration(family: StrategyWalkForwardInput['family'], candles: OHLCV[]): void {
    const cells = expandGrid(family);
    const input: StrategyWalkForwardInput = {
      candles,
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family,
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
  }

  // The plain trending random walk (same fixture strategy-walk-forward.test.ts
  // uses) is enough for fade-composite, oscillator-reversion, and
  // stochrsi-momentum to trade somewhere across an 18-cell grid. It did not
  // reliably do so for return-reversal (a z-score fade needs a genuinely
  // sharp move relative to its own trailing vol, which a smooth trend/noise
  // walk rarely produces within the grid's Z range), so that family runs
  // against a synthetic series with a sharp drop instead (a large forced
  // move well outside recent volatility, guaranteeing |z| exceeds every
  // grid Z at some bar).
  const randomWalk = generateCandles(1200);
  const sharpDrop = sharpDropCandles(1200, 700, 5, 0.2);

  it('fade-composite completes without throwing and produces an oos trade', () => {
    runIntegration(fadeCompositeFamily, randomWalk);
  });

  it('return-reversal completes without throwing and produces an oos trade', () => {
    runIntegration(returnReversalFamily, sharpDrop);
  });

  it('oscillator-reversion completes without throwing and produces an oos trade', () => {
    runIntegration(oscillatorReversionFamily, randomWalk);
  });

  it('stochrsi-momentum completes without throwing and produces an oos trade', () => {
    runIntegration(stochrsiMomentumFamily, randomWalk);
  });
});
