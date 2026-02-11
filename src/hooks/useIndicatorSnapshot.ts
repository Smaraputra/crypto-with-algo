'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { IndicatorSnapshot } from '@/types/indicator-snapshot';

interface SignalComponent {
  category: string;
  score: number;
  weight: number;
  weightedScore: number;
  signals: Array<{
    name: string;
    direction: string;
    strength: number;
    description: string;
  }>;
}

interface SignalResponse {
  signals: Array<{
    _id: string;
    symbol: string;
    interval: string;
    score: number;
    tier: string;
    confidence: number;
    components: SignalComponent[];
  }>;
}

function extractNumericValue(description: string): number | null {
  const match = description.match(/([-]?\d+\.?\d*)/);
  return match ? parseFloat(match[1]) : null;
}

function buildSnapshot(components: SignalComponent[]): IndicatorSnapshot {
  const snapshot: IndicatorSnapshot = {
    rsi: null,
    macdLine: null,
    macdSignal: null,
    macdHistogram: null,
    bollingerUpper: null,
    bollingerMiddle: null,
    bollingerLower: null,
    ema12: null,
    ema26: null,
    sma50: null,
    sma200: null,
    atr: null,
    stochRsiK: null,
    stochRsiD: null,
    williamsR: null,
    obv: null,
    mfi: null,
    superTrendDirection: null,
    fearGreedIndex: null,
    fearGreedLabel: null,
  };

  for (const component of components) {
    for (const signal of component.signals) {
      const name = signal.name.toLowerCase();
      const value = extractNumericValue(signal.description);

      if (name.includes('rsi') && !name.includes('stoch')) {
        snapshot.rsi = value;
      } else if (name.includes('macd')) {
        snapshot.macdLine = value;
      } else if (name.includes('ema') && name.includes('cross')) {
        // EMA cross signals don't have individual values
      } else if (name.includes('bollinger')) {
        // Bollinger signals are directional, not individual bands
      } else if (name.includes('atr')) {
        snapshot.atr = value;
      } else if (name.includes('stoch') && name.includes('rsi')) {
        snapshot.stochRsiK = value;
      } else if (name.includes('williams')) {
        snapshot.williamsR = value;
      } else if (name.includes('obv')) {
        snapshot.obv = value;
      } else if (name.includes('mfi')) {
        snapshot.mfi = value;
      } else if (name.includes('supertrend') || name.includes('super trend')) {
        snapshot.superTrendDirection = signal.direction === 'bullish' ? 'up' : 'down';
      } else if (name.includes('fear') || name.includes('greed')) {
        snapshot.fearGreedIndex = value;
        snapshot.fearGreedLabel = signal.description;
      }
    }
  }

  return snapshot;
}

export function useIndicatorSnapshot(symbol: string | null, interval: string = '1h') {
  return useQuery<IndicatorSnapshot | null>({
    queryKey: ['indicator-snapshot', symbol, interval],
    queryFn: async () => {
      if (!symbol) return null;
      const data: SignalResponse = await fetchJson(
        `/api/signals?symbol=${symbol}&limit=1`
      );
      if (!data.signals?.length) return null;
      return buildSnapshot(data.signals[0].components);
    },
    enabled: !!symbol,
    staleTime: 60_000,
  });
}

export { buildSnapshot };
