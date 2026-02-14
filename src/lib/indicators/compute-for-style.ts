import type { TradingStyle } from '@/lib/models/signal-template';
import type { IndicatorSuite } from './types';
import type { OHLCV } from '@/types/market';
import { computeAllIndicators } from './compute';
import { interpretIndicators } from './interpret';
import { getStyleConfig } from './style-configs';

/**
 * Compute and interpret indicators using style-specific parameters.
 *
 * Each trading style has different indicator periods and configurations
 * (e.g., scalping uses EMA 5/13 while position trading uses EMA 50/200).
 * This function selects the correct config and skips irrelevant indicators
 * (e.g., Ichimoku is skipped for scalping).
 */
export function computeIndicatorsForStyle(
  candles: OHLCV[],
  symbol: string,
  interval: string,
  tradingStyle: TradingStyle
): IndicatorSuite {
  const profile = getStyleConfig(tradingStyle);

  const raw = computeAllIndicators(candles, symbol, interval, profile.config);

  // Null out skipped indicators before interpretation
  const adjusted = { ...raw };
  if (profile.skipIndicators.includes('ichimoku')) {
    adjusted.ichimoku = null;
  }

  return interpretIndicators(adjusted);
}
