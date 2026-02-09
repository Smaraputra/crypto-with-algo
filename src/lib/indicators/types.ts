import type { OHLCV } from '@/types/market';

// Individual indicator results

export interface EMAResult {
  period: number;
  values: number[];
  current: number;
}

export interface SMAResult {
  period: number;
  values: number[];
  current: number;
}

export interface RSIResult {
  period: number;
  values: number[];
  current: number;
}

export interface MACDValue {
  MACD: number;
  signal: number;
  histogram: number;
}

export interface MACDResult {
  values: MACDValue[];
  current: MACDValue;
}

export interface BollingerBandsValue {
  upper: number;
  middle: number;
  lower: number;
  pb: number; // %B: (price - lower) / (upper - lower)
}

export interface BollingerBandsResult {
  values: BollingerBandsValue[];
  current: BollingerBandsValue;
}

export interface ATRResult {
  period: number;
  values: number[];
  current: number;
}

export interface StochasticRSIValue {
  stochRSI: number;
  k: number;
  d: number;
}

export interface StochasticRSIResult {
  values: StochasticRSIValue[];
  current: StochasticRSIValue;
}

export interface WilliamsRResult {
  period: number;
  values: number[];
  current: number;
}

export interface IchimokuValue {
  conversion: number; // Tenkan-sen
  base: number; // Kijun-sen
  spanA: number; // Senkou Span A
  spanB: number; // Senkou Span B
}

export interface IchimokuResult {
  values: IchimokuValue[];
  current: IchimokuValue;
}

export interface OBVResult {
  values: number[];
  current: number;
  sma20: number; // 20-period SMA of OBV for trend
}

export interface MFIResult {
  period: number;
  values: number[];
  current: number;
}

export interface VolumeAnalysis {
  currentVolume: number;
  sma20Volume: number;
  ratio: number; // current / sma20
}

// Signal interpretation

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

export interface IndicatorSignal {
  name: string;
  value: number;
  direction: SignalDirection;
  strength: number; // 0 to 100
  description: string;
}

// Aggregated indicator suite

export interface IndicatorSuite {
  // Raw results
  ema12: EMAResult;
  ema26: EMAResult;
  sma50: SMAResult;
  sma200: SMAResult;
  rsi: RSIResult;
  macd: MACDResult;
  bollingerBands: BollingerBandsResult;
  atr: ATRResult;
  stochasticRSI: StochasticRSIResult;
  williamsR: WilliamsRResult;
  ichimoku: IchimokuResult | null; // Requires more data points
  obv: OBVResult;
  mfi: MFIResult;
  volumeAnalysis: VolumeAnalysis;

  // Interpreted signals per category
  signals: {
    trend: IndicatorSignal[];
    momentum: IndicatorSignal[];
    volatility: IndicatorSignal[];
    volume: IndicatorSignal[];
  };

  // Source data info
  symbol: string;
  interval: string;
  candleCount: number;
  lastCandleTime: number;
}

// Configuration for indicator computation

export interface IndicatorConfig {
  ema: { fast: number; slow: number };
  sma: { medium: number; long: number };
  rsi: { period: number; overbought: number; oversold: number };
  macd: { fast: number; slow: number; signal: number };
  bollingerBands: { period: number; stdDev: number };
  atr: { period: number };
  stochasticRSI: {
    rsiPeriod: number;
    stochasticPeriod: number;
    kPeriod: number;
    dPeriod: number;
  };
  williamsR: { period: number };
  ichimoku: {
    conversionPeriod: number;
    basePeriod: number;
    spanPeriod: number;
    displacement: number;
  };
  mfi: { period: number };
}

export const DEFAULT_CONFIG: IndicatorConfig = {
  ema: { fast: 12, slow: 26 },
  sma: { medium: 50, long: 200 },
  rsi: { period: 14, overbought: 70, oversold: 30 },
  macd: { fast: 12, slow: 26, signal: 9 },
  bollingerBands: { period: 20, stdDev: 2 },
  atr: { period: 14 },
  stochasticRSI: {
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  },
  williamsR: { period: 14 },
  ichimoku: {
    conversionPeriod: 9,
    basePeriod: 26,
    spanPeriod: 52,
    displacement: 26,
  },
  mfi: { period: 14 },
};

// Minimum candles needed for full indicator suite
// Ichimoku needs 52 (spanPeriod) + 26 (displacement) = 78 minimum
// SMA(200) needs 200
// In practice, we request 500 candles to have enough history
export const MIN_CANDLES = 200;
export const RECOMMENDED_CANDLES = 500;

export type { OHLCV };
