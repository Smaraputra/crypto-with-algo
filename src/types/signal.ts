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
}

export const DEFAULT_WEIGHTS: SignalWeights = {
  trend: 0.25,
  momentum: 0.25,
  volume: 0.15,
  volatility: 0.10,
  futures: 0.15,
  sentiment: 0.10,
};

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
