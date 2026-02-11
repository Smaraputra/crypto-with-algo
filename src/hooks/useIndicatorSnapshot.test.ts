import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/fetch-json';
import { useIndicatorSnapshot, buildSnapshot } from './useIndicatorSnapshot';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const mockSignalComponents = [
  {
    category: 'momentum',
    score: 60,
    weight: 0.25,
    weightedScore: 15,
    signals: [
      { name: 'RSI', direction: 'bullish', strength: 62, description: 'RSI at 62' },
      { name: 'Stochastic RSI', direction: 'bullish', strength: 75, description: 'StochRSI K at 75' },
      { name: 'Williams %R', direction: 'bearish', strength: 25, description: 'Williams %R at -25' },
      { name: 'MFI', direction: 'bullish', strength: 60, description: 'MFI at 60' },
    ],
  },
  {
    category: 'trend',
    score: 45,
    weight: 0.25,
    weightedScore: 11.25,
    signals: [
      { name: 'EMA Cross', direction: 'bullish', strength: 70, description: 'EMA12 above EMA26' },
      { name: 'SuperTrend', direction: 'bullish', strength: 80, description: 'SuperTrend bullish' },
    ],
  },
  {
    category: 'volatility',
    score: 30,
    weight: 0.1,
    weightedScore: 3,
    signals: [
      { name: 'ATR', direction: 'neutral', strength: 50, description: 'ATR at 500' },
    ],
  },
];

describe('buildSnapshot', () => {
  it('extracts RSI from momentum signals', () => {
    const snapshot = buildSnapshot(mockSignalComponents);
    expect(snapshot.rsi).toBe(62);
  });

  it('extracts StochRSI from momentum signals', () => {
    const snapshot = buildSnapshot(mockSignalComponents);
    expect(snapshot.stochRsiK).toBe(75);
  });

  it('extracts Williams %R', () => {
    const snapshot = buildSnapshot(mockSignalComponents);
    expect(snapshot.williamsR).toBe(-25);
  });

  it('extracts MFI', () => {
    const snapshot = buildSnapshot(mockSignalComponents);
    expect(snapshot.mfi).toBe(60);
  });

  it('extracts ATR', () => {
    const snapshot = buildSnapshot(mockSignalComponents);
    expect(snapshot.atr).toBe(500);
  });

  it('extracts SuperTrend direction', () => {
    const snapshot = buildSnapshot(mockSignalComponents);
    expect(snapshot.superTrendDirection).toBe('up');
  });

  it('returns null for missing indicators', () => {
    const snapshot = buildSnapshot(mockSignalComponents);
    expect(snapshot.obv).toBeNull();
    expect(snapshot.bollingerUpper).toBeNull();
    expect(snapshot.ema12).toBeNull();
  });

  it('handles empty components', () => {
    const snapshot = buildSnapshot([]);
    expect(snapshot.rsi).toBeNull();
    expect(snapshot.macdLine).toBeNull();
  });
});

describe('useIndicatorSnapshot', () => {
  it('fetches snapshot for a symbol', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      signals: [
        {
          _id: 's1',
          symbol: 'BTCUSDT',
          interval: '1h',
          score: 45,
          tier: 'buy',
          confidence: 85,
          components: mockSignalComponents,
        },
      ],
    });

    const { result } = renderHook(() => useIndicatorSnapshot('BTCUSDT'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith('/api/signals?symbol=BTCUSDT&limit=1');
    expect(result.current.data?.rsi).toBe(62);
  });

  it('returns null when no signals found', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ signals: [] });

    const { result } = renderHook(() => useIndicatorSnapshot('BTCUSDT'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('does not fetch when symbol is null', () => {
    renderHook(() => useIndicatorSnapshot(null), {
      wrapper: createWrapper(),
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
