import type { TradingStyle } from '@/lib/models/signal-template';
import { computeIndicatorsForStyle } from '@/lib/indicators/compute-for-style';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeSignalScore } from '@/lib/signals/scorer';
import type { FuturesData } from '@/types/futures';
import type { OHLCV } from '@/types/market';
import type {
  CompositeSignal,
  HtfContext,
  SentimentData,
  SignalWeights,
} from '@/types/signal';

export interface ScoreBarInput {
  /** Closed window, oldest first; the LAST element is the bar being scored. */
  candles: OHLCV[];
  symbol: string;
  interval: string;
  style: TradingStyle;
  futures: FuturesData | null;
  sentiment: SentimentData | null;
  weights: SignalWeights;
  htfContext: HtfContext | null;
}

/**
 * The scheduler's pure scoring step: style-specific indicators, SuperTrend,
 * then the composite score. Pure and browser-safe (no I/O), so the scheduler
 * and any display-only caller run the identical code on identical inputs.
 */
export function scoreBar(input: ScoreBarInput): CompositeSignal {
  const { candles, symbol, interval, style, futures, sentiment, weights, htfContext } = input;
  const indicators = computeIndicatorsForStyle(candles, symbol, interval, style);
  const superTrend = computeSuperTrend(candles);
  return computeSignalScore(indicators, futures, sentiment, weights, superTrend, htfContext);
}
