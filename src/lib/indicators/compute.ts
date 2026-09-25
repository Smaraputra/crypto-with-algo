import {
  ATR,
  BollingerBands,
  EMA,
  IchimokuCloud,
  MACD,
  MFI,
  OBV,
  RSI,
  SMA,
  StochasticRSI,
  WilliamsR,
} from 'technicalindicators';

import type {
  ATRResult,
  BollingerBandsResult,
  EMAResult,
  IchimokuResult,
  IndicatorConfig,
  MACDResult,
  MFIResult,
  OHLCV,
  OBVResult,
  RSIResult,
  SMAResult,
  StochasticRSIResult,
  VolumeAnalysis,
  WilliamsRResult,
} from './types';
import { DEFAULT_CONFIG } from './types';

function extractOHLCV(candles: OHLCV[]) {
  return {
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
    takerBuyVolume: candles.map((c) => c.takerBuyVolume),
  };
}

export function computeEMA(closes: number[], period: number): EMAResult {
  const values = EMA.calculate({ values: closes, period });
  return {
    period,
    values,
    current: values[values.length - 1] ?? 0,
  };
}

export function computeSMA(closes: number[], period: number): SMAResult {
  const values = SMA.calculate({ values: closes, period });
  return {
    period,
    values,
    current: values[values.length - 1] ?? 0,
  };
}

export function computeRSI(closes: number[], period: number): RSIResult {
  const values = RSI.calculate({ values: closes, period });
  return {
    period,
    values,
    current: values[values.length - 1] ?? 50,
  };
}

export function computeMACD(
  closes: number[],
  fast: number,
  slow: number,
  signal: number
): MACDResult {
  const raw = MACD.calculate({
    values: closes,
    fastPeriod: fast,
    slowPeriod: slow,
    signalPeriod: signal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const values = raw.map((r) => ({
    MACD: r.MACD ?? 0,
    signal: r.signal ?? 0,
    histogram: r.histogram ?? 0,
  }));

  return {
    values,
    current: values[values.length - 1] ?? { MACD: 0, signal: 0, histogram: 0 },
  };
}

export function computeBollingerBands(
  closes: number[],
  period: number,
  stdDev: number
): BollingerBandsResult {
  const raw = BollingerBands.calculate({
    values: closes,
    period,
    stdDev,
  });

  const values = raw.map((r) => ({
    upper: r.upper,
    middle: r.middle,
    lower: r.lower,
    pb: r.pb,
  }));

  return {
    values,
    current: values[values.length - 1] ?? {
      upper: 0,
      middle: 0,
      lower: 0,
      pb: 0.5,
    },
  };
}

export function computeATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number
): ATRResult {
  const values = ATR.calculate({ high: highs, low: lows, close: closes, period });
  return {
    period,
    values,
    current: values[values.length - 1] ?? 0,
  };
}

export function computeStochasticRSI(
  closes: number[],
  rsiPeriod: number,
  stochasticPeriod: number,
  kPeriod: number,
  dPeriod: number
): StochasticRSIResult {
  const raw = StochasticRSI.calculate({
    values: closes,
    rsiPeriod,
    stochasticPeriod,
    kPeriod,
    dPeriod,
  });

  const values = raw.map((r) => ({
    stochRSI: r.stochRSI,
    k: r.k,
    d: r.d,
  }));

  return {
    values,
    current: values[values.length - 1] ?? { stochRSI: 50, k: 50, d: 50 },
  };
}

export function computeWilliamsR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number
): WilliamsRResult {
  const values = WilliamsR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period,
  });

  return {
    period,
    values,
    current: values[values.length - 1] ?? -50,
  };
}

export function computeIchimoku(
  highs: number[],
  lows: number[],
  _closes: number[],
  config: IndicatorConfig['ichimoku']
): IchimokuResult | null {
  // Ichimoku needs at least spanPeriod data points
  if (highs.length < config.spanPeriod) return null;

  const raw = IchimokuCloud.calculate({
    high: highs,
    low: lows,
    conversionPeriod: config.conversionPeriod,
    basePeriod: config.basePeriod,
    spanPeriod: config.spanPeriod,
    displacement: config.displacement,
  });

  if (raw.length === 0) return null;

  const values = raw.map((r) => ({
    conversion: r.conversion,
    base: r.base,
    spanA: r.spanA,
    spanB: r.spanB,
  }));

  return {
    values,
    current: values[values.length - 1],
  };
}

export function computeOBV(
  closes: number[],
  volumes: number[]
): OBVResult {
  const values = OBV.calculate({ close: closes, volume: volumes });
  const smaValues = values.length >= 20
    ? SMA.calculate({ values, period: 20 })
    : [];

  return {
    values,
    current: values[values.length - 1] ?? 0,
    sma20: smaValues[smaValues.length - 1] ?? values[values.length - 1] ?? 0,
  };
}

export function computeMFI(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  period: number
): MFIResult {
  const values = MFI.calculate({
    high: highs,
    low: lows,
    close: closes,
    volume: volumes,
    period,
  });

  return {
    period,
    values,
    current: values[values.length - 1] ?? 50,
  };
}

export function computeTakerBuyRatio(
  takerBuyVolume: number | undefined,
  volume: number
): number | undefined {
  if (takerBuyVolume === undefined || Number.isNaN(takerBuyVolume) || volume <= 0) {
    return undefined;
  }
  return takerBuyVolume / volume;
}

/** Bars of trailing history the taker ratio's own centre and spread are measured over. */
export const TAKER_RATIO_SCALE_BARS = 20;

/**
 * How far the current taker-buy ratio sits from its own recent mean, in that
 * window's standard deviations.
 *
 * A fixed 0.55/0.45 band was both miscentred and interval-blind: measured over
 * ten symbols the ratio's centre is 0.492 to 0.495 rather than 0.5, so the band
 * fired bearish more often than bullish at every interval, and its dispersion
 * shrinks with bar duration, so the band caught 77.9% of 5m bars against 6.3%
 * of 1d bars. A z against the ratio's own history fixes both at once, the same
 * shape the research code already uses for funding.
 *
 * The window includes the evaluated bar, which bounds |z| at sqrt(n-1) and
 * never reads past it. Undefined when the bar has no taker volume or the
 * window has no spread to speak of.
 */
export function computeTakerBuyRatioZ(
  bars: ReadonlyArray<{ volume: number; takerBuyVolume?: number }>,
  endIndex: number
): number | undefined {
  const endBar = bars[endIndex];
  if (endBar === undefined) return undefined;
  const current = computeTakerBuyRatio(endBar.takerBuyVolume, endBar.volume);
  if (current === undefined) return undefined;

  // Indexed directly rather than over mapped arrays: this runs once per bar in
  // a research pass, and building two arrays per call is the O(n^2) allocation
  // that exhausted a 4 GB heap on the 808k-bar 5m series once before.
  const ratios: number[] = [];
  for (let i = Math.max(0, endIndex - (TAKER_RATIO_SCALE_BARS - 1)); i <= endIndex; i++) {
    const bar = bars[i];
    if (bar === undefined) continue;
    const ratio = computeTakerBuyRatio(bar.takerBuyVolume, bar.volume);
    if (ratio !== undefined) ratios.push(ratio);
  }
  if (ratios.length < 3) return undefined;

  const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  const variance = ratios.reduce((sum, r) => sum + (r - mean) ** 2, 0) / ratios.length;
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return undefined;

  return (current - mean) / sd;
}

/**
 * EMA fast-minus-slow spread, as a percentage of the slow EMA, per bar.
 *
 * Carried on the raw set so `interpretEMACross` can measure the spread's own
 * recent magnitude without re-deriving it, and without either interpret path
 * having to align two EMA arrays of different warmup lengths itself. Both
 * `values` arrays end on the current bar, so they are aligned from the end and
 * the result has the length of the shorter (slower) one.
 */
export function computeEmaSpreadPct(
  fast: EMAResult,
  slow: EMAResult
): { values: number[]; current: number } {
  const n = Math.min(fast.values.length, slow.values.length);
  const fastOffset = fast.values.length - n;
  const slowOffset = slow.values.length - n;
  const values: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const slowValue = slow.values[i + slowOffset];
    values[i] = slowValue !== 0 ? ((fast.values[i + fastOffset] - slowValue) / slowValue) * 100 : 0;
  }
  return { values, current: values[n - 1] ?? 0 };
}

export function computeVolumeAnalysis(
  volumes: number[],
  closes: number[] = [],
  takerBuyVolumes: Array<number | undefined> = []
): VolumeAnalysis {
  const current = volumes[volumes.length - 1] ?? 0;
  const sma20Values = volumes.length >= 20
    ? SMA.calculate({ values: volumes, period: 20 })
    : [];
  const sma20 = sma20Values[sma20Values.length - 1] ?? current;

  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const priceChangePercent =
    lastClose !== undefined && prevClose !== undefined && prevClose !== 0
      ? ((lastClose - prevClose) / prevClose) * 100
      : 0;

  const takerBuyRatio = computeTakerBuyRatio(
    takerBuyVolumes[takerBuyVolumes.length - 1],
    current
  );


  return {
    currentVolume: current,
    sma20Volume: sma20,
    ratio: sma20 > 0 ? current / sma20 : 1,
    priceChangePercent,
    ...(takerBuyRatio !== undefined ? { takerBuyRatio } : {}),
  };
}

/**
 * Compute the minimum number of candles needed for a given indicator config.
 * Driven by the longest warmup period -- typically SMA long or Ichimoku span+displacement.
 * Pass skipIndicators to exclude skipped indicators from the calculation.
 */
export function computeMinCandles(config: IndicatorConfig, skipIndicators: string[] = []): number {
  const periods = [
    config.ema.slow,
    config.sma.long,
    config.rsi.period,
    config.macd.slow + config.macd.signal,
    config.bollingerBands.period,
    config.atr.period,
    config.stochasticRSI.rsiPeriod + config.stochasticRSI.stochasticPeriod,
    config.williamsR.period,
    config.mfi.period,
  ];

  if (!skipIndicators.includes('ichimoku')) {
    periods.push(config.ichimoku.spanPeriod + config.ichimoku.displacement);
  }

  // Need at least the longest warmup period plus a small buffer
  return Math.max(...periods) + 10;
}

export function computeAllIndicators(
  candles: OHLCV[],
  symbol: string,
  interval: string,
  config: IndicatorConfig = DEFAULT_CONFIG
) {
  const minCandles = computeMinCandles(config);
  if (candles.length < minCandles) {
    throw new Error(
      `Insufficient candle data: got ${candles.length}, need at least ${minCandles}`
    );
  }

  const { high, low, close, volume, takerBuyVolume } = extractOHLCV(candles);

  const takerRatioZ = computeTakerBuyRatioZ(candles, candles.length - 1);
  const ema12 = computeEMA(close, config.ema.fast);
  const ema26 = computeEMA(close, config.ema.slow);

  return {
    ema12,
    ema26,
    emaSpreadPct: computeEmaSpreadPct(ema12, ema26),
    sma50: computeSMA(close, config.sma.medium),
    sma200: computeSMA(close, config.sma.long),
    rsi: computeRSI(close, config.rsi.period),
    macd: computeMACD(
      close,
      config.macd.fast,
      config.macd.slow,
      config.macd.signal
    ),
    bollingerBands: computeBollingerBands(
      close,
      config.bollingerBands.period,
      config.bollingerBands.stdDev
    ),
    atr: computeATR(high, low, close, config.atr.period),
    stochasticRSI: computeStochasticRSI(
      close,
      config.stochasticRSI.rsiPeriod,
      config.stochasticRSI.stochasticPeriod,
      config.stochasticRSI.kPeriod,
      config.stochasticRSI.dPeriod
    ),
    williamsR: computeWilliamsR(high, low, close, config.williamsR.period),
    ichimoku: computeIchimoku(high, low, close, config.ichimoku),
    obv: computeOBV(close, volume),
    mfi: computeMFI(high, low, close, volume, config.mfi.period),
    volumeAnalysis: {
      ...computeVolumeAnalysis(volume, close, takerBuyVolume),
      ...(takerRatioZ !== undefined ? { takerBuyRatioZ: takerRatioZ } : {}),
    },
    symbol,
    interval,
    candleCount: candles.length,
    lastCandleTime: candles[candles.length - 1].timestamp,
    /**
     * The last bar's actual close.
     *
     * `interpretIndicators` needs a price to compare the moving averages
     * against and previously derived one as `raw.ema12.values[length - 1]` --
     * which `computeEMA` defines as `ema12.current`, the very value it was then
     * compared to. `close > ema12` was therefore always false, and
     * interpretSMATrend, interpretIchimoku and interpretATR were all handed
     * EMA(fast) where they expect the close. Carried here alongside
     * lastCandleTime so no caller has to thread it through.
     */
    lastClose: close[close.length - 1],
  };
}
