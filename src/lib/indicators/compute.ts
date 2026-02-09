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
import { DEFAULT_CONFIG, MIN_CANDLES } from './types';

function extractOHLCV(candles: OHLCV[]) {
  return {
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
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

export function computeVolumeAnalysis(volumes: number[]): VolumeAnalysis {
  const current = volumes[volumes.length - 1] ?? 0;
  const sma20Values = volumes.length >= 20
    ? SMA.calculate({ values: volumes, period: 20 })
    : [];
  const sma20 = sma20Values[sma20Values.length - 1] ?? current;

  return {
    currentVolume: current,
    sma20Volume: sma20,
    ratio: sma20 > 0 ? current / sma20 : 1,
  };
}

export function computeAllIndicators(
  candles: OHLCV[],
  symbol: string,
  interval: string,
  config: IndicatorConfig = DEFAULT_CONFIG
) {
  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `Insufficient candle data: got ${candles.length}, need at least ${MIN_CANDLES}`
    );
  }

  const { high, low, close, volume } = extractOHLCV(candles);

  return {
    ema12: computeEMA(close, config.ema.fast),
    ema26: computeEMA(close, config.ema.slow),
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
    volumeAnalysis: computeVolumeAnalysis(volume),
    symbol,
    interval,
    candleCount: candles.length,
    lastCandleTime: candles[candles.length - 1].timestamp,
  };
}
