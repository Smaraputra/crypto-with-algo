import type { CompositeSignal, SignalComponent, SentimentData } from '@/types/signal';

export const mockTrendComponent: SignalComponent = {
  category: 'trend',
  score: 65,
  weight: 0.25,
  weightedScore: 16.25,
  signals: [
    { name: 'EMA Cross', direction: 'bullish', strength: 75, description: 'EMA12 above EMA26' },
    { name: 'SMA Trend', direction: 'bullish', strength: 60, description: 'Price above SMA200' },
    { name: 'SuperTrend', direction: 'bullish', strength: 70, description: 'Uptrend signal' },
  ],
};

export const mockMomentumComponent: SignalComponent = {
  category: 'momentum',
  score: -35,
  weight: 0.25,
  weightedScore: -8.75,
  signals: [
    { name: 'RSI', direction: 'bearish', strength: 65, description: 'RSI at 72 (overbought)' },
    { name: 'MACD', direction: 'bearish', strength: 40, description: 'MACD histogram declining' },
    { name: 'StochRSI', direction: 'bearish', strength: 55, description: 'StochRSI overbought' },
  ],
};

export const mockVolumeComponent: SignalComponent = {
  category: 'volume',
  score: 20,
  weight: 0.15,
  weightedScore: 3.0,
  signals: [
    { name: 'OBV', direction: 'bullish', strength: 30, description: 'OBV rising' },
    { name: 'MFI', direction: 'neutral', strength: 10, description: 'MFI at 55' },
  ],
};

export const mockVolatilityComponent: SignalComponent = {
  category: 'volatility',
  score: 10,
  weight: 0.10,
  weightedScore: 1.0,
  signals: [
    { name: 'Bollinger %B', direction: 'neutral', strength: 15, description: '%B at 0.55' },
    { name: 'ATR Regime', direction: 'bullish', strength: 20, description: 'ATR expanding' },
  ],
};

export const mockFuturesComponent: SignalComponent = {
  category: 'futures',
  score: 40,
  weight: 0.15,
  weightedScore: 6.0,
  signals: [
    { name: 'Funding Rate', direction: 'bullish', strength: 50, description: 'Negative funding (-0.01%)' },
    { name: 'OI Change', direction: 'bullish', strength: 30, description: 'OI increasing' },
    { name: 'L/S Ratio', direction: 'neutral', strength: 10, description: 'L/S ratio near 1.0' },
  ],
};

export const mockSentimentComponent: SignalComponent = {
  category: 'sentiment',
  score: 55,
  weight: 0.10,
  weightedScore: 5.5,
  signals: [
    { name: 'Fear & Greed', direction: 'bullish', strength: 55, description: 'Fear index at 25 (extreme fear)' },
  ],
};

export const mockAllComponents: SignalComponent[] = [
  mockTrendComponent,
  mockMomentumComponent,
  mockVolumeComponent,
  mockVolatilityComponent,
  mockFuturesComponent,
  mockSentimentComponent,
];

export const mockBullishSignal: CompositeSignal = {
  symbol: 'BTCUSDT',
  interval: '1h',
  score: 45,
  tier: 'buy',
  confidence: 100,
  components: mockAllComponents,
  timestamp: 1700000000000,
};

export const mockBearishSignal: CompositeSignal = {
  symbol: 'ETHUSDT',
  interval: '4h',
  score: -52,
  tier: 'sell',
  confidence: 85,
  components: [
    {
      category: 'trend',
      score: -70,
      weight: 0.25,
      weightedScore: -17.5,
      signals: [
        { name: 'EMA Cross', direction: 'bearish', strength: 80, description: 'EMA12 below EMA26' },
        { name: 'SMA Trend', direction: 'bearish', strength: 65, description: 'Price below SMA200' },
      ],
    },
    {
      category: 'momentum',
      score: -60,
      weight: 0.25,
      weightedScore: -15.0,
      signals: [
        { name: 'RSI', direction: 'bearish', strength: 70, description: 'RSI at 28 (oversold)' },
        { name: 'MACD', direction: 'bearish', strength: 55, description: 'MACD bearish crossover' },
      ],
    },
    {
      category: 'volume',
      score: -30,
      weight: 0.15,
      weightedScore: -4.5,
      signals: [
        { name: 'OBV', direction: 'bearish', strength: 40, description: 'OBV declining' },
      ],
    },
  ],
  timestamp: 1700100000000,
};

export const mockNeutralSignal: CompositeSignal = {
  symbol: 'SOLUSDT',
  interval: '1h',
  score: 5,
  tier: 'neutral',
  confidence: 90,
  components: [
    {
      category: 'trend',
      score: 10,
      weight: 0.25,
      weightedScore: 2.5,
      signals: [
        { name: 'EMA Cross', direction: 'neutral', strength: 10, description: 'EMA12 near EMA26' },
      ],
    },
    {
      category: 'momentum',
      score: -5,
      weight: 0.25,
      weightedScore: -1.25,
      signals: [
        { name: 'RSI', direction: 'neutral', strength: 5, description: 'RSI at 52' },
      ],
    },
  ],
  timestamp: 1700200000000,
};

export const mockStrongBuySignal: CompositeSignal = {
  symbol: 'BTCUSDT',
  interval: '1d',
  score: 78,
  tier: 'strong_buy',
  confidence: 100,
  components: mockAllComponents.map((c) => ({
    ...c,
    score: Math.abs(c.score) + 20,
    weightedScore: (Math.abs(c.score) + 20) * c.weight,
    signals: c.signals.map((s) => ({
      ...s,
      direction: 'bullish' as const,
      strength: Math.min(s.strength + 20, 100),
    })),
  })),
  timestamp: 1700300000000,
};

export const mockPersistedSignal = {
  _id: 'signal-1',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  score: 45,
  tier: 'buy' as const,
  confidence: 100,
  components: mockAllComponents,
  createdAt: '2024-01-15T12:00:00.000Z',
  updatedAt: '2024-01-15T12:00:00.000Z',
};

export const mockSignalHistory = Array.from({ length: 10 }, (_, i) => ({
  _id: `signal-${i + 1}`,
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  score: Math.round(Math.sin(i * 0.8) * 60),
  tier: (Math.sin(i * 0.8) * 60 > 60
    ? 'strong_buy'
    : Math.sin(i * 0.8) * 60 > 30
      ? 'buy'
      : Math.sin(i * 0.8) * 60 > -30
        ? 'neutral'
        : Math.sin(i * 0.8) * 60 > -60
          ? 'sell'
          : 'strong_sell') as CompositeSignal['tier'],
  confidence: 85 + i,
  components: mockAllComponents.slice(0, 3),
  createdAt: new Date(Date.now() - i * 3600000).toISOString(),
  updatedAt: new Date(Date.now() - i * 3600000).toISOString(),
}));

export const mockSentimentData: SentimentData = {
  fearGreedIndex: 25,
  label: 'Extreme Fear',
};

export const mockSentimentGreed: SentimentData = {
  fearGreedIndex: 82,
  label: 'Extreme Greed',
};
