import type { TradingStyle } from '@/lib/models/signal-template';
import type { FuturesData } from '@/types/futures';
import type { OHLCV } from '@/types/market';
import type {
  CompositeSignal,
  HtfContext,
  SentimentData,
  SignalTier,
  SignalWeights,
} from '@/types/signal';

/**
 * Wire types for the provisional (forming-bar) score. The server serves the
 * scorer's INPUTS only; the score is computed in the browser and never sent
 * back, never stored.
 */
export interface ProvisionalContextReady {
  ready: true;
  /** SCORER_CONFIG_VERSION the inputs were assembled under. */
  configVersion: number;
  symbol: string;
  interval: string;
  style: TradingStyle;
  /** Open time (ms) of the bar forming at request time. */
  formingOpenTime: number;
  /**
   * Newest (recommendedCandles - 1) closed bars, oldest first, with
   * takerBuyVolume. The last opens at formingOpenTime - intervalMs.
   */
  closedCandles: OHLCV[];
  /** Stored-snapshot futures input for the forming bar. */
  futures: FuturesData | null;
  sentiment: SentimentData | null;
  weights: SignalWeights;
  /**
   * From HTF bars closed at request time. At an HTF boundary this can be one
   * HTF bar older than the scheduler's, so the score can shift at the close.
   */
  htfContext: HtfContext | null;
  generatedAt: number;
}

export interface ProvisionalContextNotReady {
  ready: false;
  reason: 'awaiting-candle-sync' | 'insufficient-history';
  configVersion: number;
  symbol: string;
  interval: string;
  style: TradingStyle;
  formingOpenTime: number;
  generatedAt: number;
}

export type ProvisionalContext = ProvisionalContextReady | ProvisionalContextNotReady;

export interface FormingBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
}

export interface ProvisionalScore {
  openTime: number;
  score: number;
  tier: SignalTier;
  confidence: number;
  components: CompositeSignal['components'];
}
