import type { IndicatorConfig } from './types';
import type { TradingStyle } from '@/lib/models/signal-template';

export interface StyleIndicatorProfile {
  /** Indicator computation parameters for this style */
  config: IndicatorConfig;
  /** Indicators to skip entirely (e.g., Ichimoku too slow for scalping) */
  skipIndicators: string[];
  /** Preferred candle intervals for this style */
  preferredIntervals: string[];
  /** How often signals should be recomputed (ms) */
  updateFrequencyMs: number;
  /** Minimum candles needed for computation */
  minCandles: number;
  /** Recommended candles for optimal indicator warmup */
  recommendedCandles: number;
  /** How long computed signals remain valid (seconds) */
  signalTTLSeconds: number;
}

export const STYLE_CONFIGS: Record<TradingStyle, StyleIndicatorProfile> = {
  scalping: {
    config: {
      ema: { fast: 5, slow: 13 },
      sma: { medium: 20, long: 50 },
      rsi: { period: 7, overbought: 70, oversold: 30 },
      macd: { fast: 5, slow: 13, signal: 5 },
      bollingerBands: { period: 10, stdDev: 2 },
      atr: { period: 7 },
      stochasticRSI: {
        rsiPeriod: 7,
        stochasticPeriod: 7,
        kPeriod: 3,
        dPeriod: 3,
      },
      williamsR: { period: 7 },
      ichimoku: {
        conversionPeriod: 9,
        basePeriod: 26,
        spanPeriod: 52,
        displacement: 26,
      },
      mfi: { period: 7 },
    },
    skipIndicators: ['ichimoku'],
    preferredIntervals: ['1m', '5m'],
    updateFrequencyMs: 60_000, // 1 minute
    minCandles: 50,
    recommendedCandles: 100,
    signalTTLSeconds: 86_400, // 1 day
  },

  day_trading: {
    config: {
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
    },
    skipIndicators: [],
    preferredIntervals: ['15m', '1h'],
    updateFrequencyMs: 300_000, // 5 minutes
    minCandles: 200,
    recommendedCandles: 500,
    signalTTLSeconds: 604_800, // 7 days
  },

  swing_trading: {
    config: {
      ema: { fast: 21, slow: 55 },
      sma: { medium: 50, long: 200 },
      rsi: { period: 21, overbought: 70, oversold: 30 },
      macd: { fast: 21, slow: 55, signal: 9 },
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
    },
    skipIndicators: [],
    preferredIntervals: ['4h', '1d'],
    updateFrequencyMs: 900_000, // 15 minutes
    minCandles: 200,
    recommendedCandles: 500,
    signalTTLSeconds: 2_592_000, // 30 days
  },

  position_trading: {
    config: {
      ema: { fast: 50, slow: 200 },
      sma: { medium: 100, long: 400 },
      rsi: { period: 28, overbought: 70, oversold: 30 },
      macd: { fast: 26, slow: 100, signal: 9 },
      bollingerBands: { period: 30, stdDev: 2 },
      atr: { period: 21 },
      stochasticRSI: {
        rsiPeriod: 21,
        stochasticPeriod: 21,
        kPeriod: 3,
        dPeriod: 3,
      },
      williamsR: { period: 28 },
      ichimoku: {
        conversionPeriod: 26,
        basePeriod: 52,
        spanPeriod: 104,
        displacement: 26,
      },
      mfi: { period: 21 },
    },
    skipIndicators: [],
    preferredIntervals: ['1d'],
    updateFrequencyMs: 3_600_000, // 1 hour
    minCandles: 400,
    recommendedCandles: 500,
    signalTTLSeconds: 7_776_000, // 90 days
  },
};

export const TRADING_STYLES: TradingStyle[] = [
  'scalping',
  'day_trading',
  'swing_trading',
  'position_trading',
];

export function getStyleConfig(style: TradingStyle): StyleIndicatorProfile {
  return STYLE_CONFIGS[style];
}

export function shouldSkipIndicator(style: TradingStyle, indicator: string): boolean {
  return STYLE_CONFIGS[style].skipIndicators.includes(indicator);
}
