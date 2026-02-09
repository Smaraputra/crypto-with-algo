import type { IndicatorSignal, IndicatorSuite } from './types';
import type { RawIndicators } from './interpret';
import type { OHLCV } from '@/types/market';
import {
  interpretEMACross,
  interpretSMATrend,
  interpretIchimoku,
  interpretRSI,
  interpretMACD,
  interpretStochasticRSI,
  interpretWilliamsR,
  interpretBollingerBands,
  interpretATR,
  interpretOBV,
  interpretMFI,
  interpretVolume,
} from './interpret';

/**
 * Compute the warmup offset -- how many candles to skip before all
 * indicator arrays have values.
 *
 * Each indicator produces an array shorter than the input candles:
 *   - EMA(12): candleCount - 11
 *   - SMA(200): candleCount - 199  <-- longest warmup
 *   - etc.
 *
 * The warmup is (candleCount - shortest array length).
 * Bars 0..warmup-1 are skipped; the backtest starts at bar = warmup.
 */
export function computeWarmupBars(raw: RawIndicators): number {
  const lengths = [
    raw.ema12.values.length,
    raw.ema26.values.length,
    raw.sma50.values.length,
    raw.sma200.values.length,
    raw.rsi.values.length,
    raw.macd.values.length,
    raw.bollingerBands.values.length,
    raw.atr.values.length,
    raw.stochasticRSI.values.length,
    raw.williamsR.values.length,
    raw.mfi.values.length,
    raw.obv.values.length,
  ];

  if (raw.ichimoku) {
    lengths.push(raw.ichimoku.values.length);
  }

  const shortest = Math.min(...lengths);
  // warmup = candleCount - shortest (all arrays should be usable from this offset)
  return raw.candleCount - shortest;
}

/**
 * Read the value at a given position from an indicator array,
 * accounting for the different warmup lengths.
 *
 * For a bar index in candle-space (0..candleCount-1):
 *   arrayIndex = barIndex - (candleCount - array.length)
 *
 * Returns undefined if the bar is before the array's warmup.
 */
function readAtBar(values: number[], barIndex: number, candleCount: number): number | undefined {
  const offset = candleCount - values.length;
  const idx = barIndex - offset;
  if (idx < 0 || idx >= values.length) return undefined;
  return values[idx];
}

function readArrayAtBar<T>(values: T[], barIndex: number, candleCount: number): T | undefined {
  const offset = candleCount - values.length;
  const idx = barIndex - offset;
  if (idx < 0 || idx >= values.length) return undefined;
  return values[idx];
}

/**
 * Interpret all indicators at a specific bar index, producing an IndicatorSuite
 * as if that bar were the "current" bar.
 *
 * This is the heart of the backtester: it lets us evaluate signals bar-by-bar
 * over a pre-computed indicator dataset without re-running compute for each bar.
 */
export function interpretIndicatorsAtBar(
  raw: RawIndicators,
  barIndex: number,
  candles: OHLCV[]
): IndicatorSuite {
  const n = raw.candleCount;
  const close = candles[barIndex].close;

  // Read indicator values at this bar
  const ema12Val = readAtBar(raw.ema12.values, barIndex, n) ?? close;
  const ema26Val = readAtBar(raw.ema26.values, barIndex, n) ?? close;
  const sma50Val = readAtBar(raw.sma50.values, barIndex, n) ?? close;
  const sma200Val = readAtBar(raw.sma200.values, barIndex, n) ?? close;
  const rsiVal = readAtBar(raw.rsi.values, barIndex, n) ?? 50;
  const macdVal = readArrayAtBar(raw.macd.values, barIndex, n) ?? {
    MACD: 0,
    signal: 0,
    histogram: 0,
  };
  const bbVal = readArrayAtBar(raw.bollingerBands.values, barIndex, n) ?? {
    upper: close,
    middle: close,
    lower: close,
    pb: 0.5,
  };
  const atrVal = readAtBar(raw.atr.values, barIndex, n) ?? 0;
  const stochVal = readArrayAtBar(raw.stochasticRSI.values, barIndex, n) ?? {
    stochRSI: 50,
    k: 50,
    d: 50,
  };
  const wrVal = readAtBar(raw.williamsR.values, barIndex, n) ?? -50;
  const mfiVal = readAtBar(raw.mfi.values, barIndex, n) ?? 50;

  // OBV SMA20 at bar: compute a simple lookback
  const obvVal = readAtBar(raw.obv.values, barIndex, n) ?? 0;
  const obvOffset = n - raw.obv.values.length;
  const obvIdx = barIndex - obvOffset;
  let obvSma20 = obvVal;
  if (obvIdx >= 19) {
    let sum = 0;
    for (let j = obvIdx - 19; j <= obvIdx; j++) {
      sum += raw.obv.values[j];
    }
    obvSma20 = sum / 20;
  }

  // Volume analysis at bar
  const currentVol = candles[barIndex].volume;
  // Approximate volume SMA20 by looking back 20 candles
  let volSma20 = currentVol;
  if (barIndex >= 19) {
    let sum = 0;
    for (let j = barIndex - 19; j <= barIndex; j++) {
      sum += candles[j].volume;
    }
    volSma20 = sum / 20;
  }

  // Ichimoku at bar
  const ichimokuAtBar = raw.ichimoku
    ? readArrayAtBar(raw.ichimoku.values, barIndex, n)
    : undefined;

  // Trend signals
  const trendSignals: IndicatorSignal[] = [
    interpretEMACross(ema12Val, ema26Val, close),
    interpretSMATrend(close, sma50Val, sma200Val),
  ];
  if (ichimokuAtBar) {
    const ichSig = interpretIchimoku(
      {
        values: raw.ichimoku!.values,
        current: ichimokuAtBar,
      },
      close
    );
    if (ichSig) trendSignals.push(ichSig);
  }

  // Momentum signals
  const momentumSignals: IndicatorSignal[] = [
    interpretRSI(rsiVal),
    interpretMACD(macdVal),
    interpretStochasticRSI(stochVal),
    interpretWilliamsR(wrVal),
  ];

  // Volatility signals
  const volatilitySignals: IndicatorSignal[] = [
    interpretBollingerBands(bbVal, close),
    interpretATR({ period: raw.atr.period, values: raw.atr.values, current: atrVal }, close),
  ];

  // Volume signals
  const volumeSignals: IndicatorSignal[] = [
    interpretOBV({ values: raw.obv.values, current: obvVal, sma20: obvSma20 }),
    interpretMFI(mfiVal),
    interpretVolume({
      currentVolume: currentVol,
      sma20Volume: volSma20,
      ratio: volSma20 > 0 ? currentVol / volSma20 : 1,
    }),
  ];

  return {
    ema12: { ...raw.ema12, current: ema12Val },
    ema26: { ...raw.ema26, current: ema26Val },
    sma50: { ...raw.sma50, current: sma50Val },
    sma200: { ...raw.sma200, current: sma200Val },
    rsi: { ...raw.rsi, current: rsiVal },
    macd: { ...raw.macd, current: macdVal },
    bollingerBands: { ...raw.bollingerBands, current: bbVal },
    atr: { ...raw.atr, current: atrVal },
    stochasticRSI: { ...raw.stochasticRSI, current: stochVal },
    williamsR: { ...raw.williamsR, current: wrVal },
    ichimoku: ichimokuAtBar
      ? { values: raw.ichimoku!.values, current: ichimokuAtBar }
      : null,
    obv: { values: raw.obv.values, current: obvVal, sma20: obvSma20 },
    mfi: { ...raw.mfi, current: mfiVal },
    volumeAnalysis: {
      currentVolume: currentVol,
      sma20Volume: volSma20,
      ratio: volSma20 > 0 ? currentVol / volSma20 : 1,
    },
    signals: {
      trend: trendSignals,
      momentum: momentumSignals,
      volatility: volatilitySignals,
      volume: volumeSignals,
    },
    symbol: raw.symbol,
    interval: raw.interval,
    candleCount: raw.candleCount,
    lastCandleTime: candles[barIndex].timestamp,
  };
}
