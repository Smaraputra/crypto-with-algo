export const SIGNAL_TIERS = [
  'strong_buy',
  'buy',
  'neutral',
  'sell',
  'strong_sell',
] as const;
export type SignalTier = (typeof SIGNAL_TIERS)[number];

export interface SignalWeights {
  trend: number;
  momentum: number;
  volume: number;
  volatility: number;
  futures: number;
  sentiment: number;
  htf: number; // higher-timeframe confluence
}

// Old six weights scaled by 0.90 plus htf 0.10: with an empty htf component
// the scorer's weight redistribution reproduces the previous scores exactly
export const DEFAULT_WEIGHTS: SignalWeights = {
  trend: 0.225,
  momentum: 0.225,
  volume: 0.135,
  volatility: 0.09,
  futures: 0.135,
  sentiment: 0.09,
  htf: 0.10,
};

export interface HtfContext {
  interval: string; // the confirmation timeframe used
  candleTimestamp: number; // open time of the last CLOSED higher-timeframe bar
  trendDirection: 'bullish' | 'bearish' | 'neutral';
  signals: Array<{
    name: string;
    value: number;
    direction: 'bullish' | 'bearish' | 'neutral';
    strength: number;
    description: string;
  }>;
}

export interface SignalComponent {
  category: keyof SignalWeights;
  score: number; // -100 to +100
  weight: number;
  weightedScore: number;
  signals: Array<{
    name: string;
    direction: 'bullish' | 'bearish' | 'neutral';
    strength: number;
    description: string;
  }>;
}

export interface CompositeSignal {
  symbol: string;
  interval: string;
  score: number; // -100 to +100
  tier: SignalTier;
  confidence: number; // 0 to 100
  components: SignalComponent[];
  timestamp: number;
}

export interface SentimentData {
  fearGreedIndex: number; // 0 (extreme fear) to 100 (extreme greed)
  label: string;
}
