import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketHome } from './MarketHome';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { useTradingChartEngine } from '@/components/chart/useTradingChartEngine';
import { useLabSummary } from '@/components/lab/useLabSummary';
import { useLatestSignalForStyle } from '@/hooks/useSignals';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';
import { useFearAndGreed } from '@/hooks/useSentiment';
import { useLatestNews } from '@/hooks/useNews';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: vi.fn(),
}));
vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(),
}));
vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));
vi.mock('@/components/chart/useTradingChartEngine', () => ({
  useTradingChartEngine: vi.fn(),
}));
vi.mock('@/components/lab/useLabSummary', () => ({
  useLabSummary: vi.fn(),
}));
vi.mock('@/hooks/useSignals', () => ({
  useLatestSignalForStyle: vi.fn(),
}));
vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: vi.fn(),
}));
vi.mock('@/hooks/useSentiment', () => ({
  useFearAndGreed: vi.fn(),
}));
vi.mock('@/hooks/useNews', () => ({
  useLatestNews: vi.fn(),
}));

describe('MarketHome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      selectedSymbol: 'BTCUSDT',
      selectedInterval: '1h',
    });

    vi.mocked(useWatchlist).mockReturnValue({
      symbols: ['BTCUSDT'],
      isLoading: false,
      addSymbol: vi.fn(),
      removeSymbol: vi.fn(),
    });

    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '68000',
          priceChange: '1000',
          priceChangePercent: '1.49',
          highPrice: '69000',
          lowPrice: '67000',
          volume: '2000',
          quoteVolume: '136000000',
          openPrice: '67000',
          count: 1000,
        },
      },
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });

    vi.mocked(useTickers).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useTickers>);

    vi.mocked(useTradingChartEngine).mockReturnValue({
      containerRef: { current: null },
      isLoading: false,
      historyError: false,
      handleRefresh: vi.fn(),
    } as unknown as ReturnType<typeof useTradingChartEngine>);

    vi.mocked(useLabSummary).mockReturnValue({
      counts: { underTest: 3, rejected: 1, validated: 1 },
      isLoading: false,
      isError: false,
      refetchFailed: vi.fn(),
    });

    vi.mocked(useLatestSignalForStyle).mockReturnValue({
      data: {
        signal: {
          _id: 'sig-1',
          symbol: 'BTCUSDT',
          interval: '1h',
          tradingStyle: 'day_trading',
          score: 20,
          tier: 'neutral',
          confidence: 50,
          components: [],
          configVersion: 1,
          candleTimestamp: 1700000000,
          expiresAt: '2026-10-23T15:00:00Z',
          createdAt: '2026-10-23T14:00:00Z',
        },
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestSignalForStyle>);

    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'live',
      lastMessageAt: Date.now(),
      isConnected: true,
      retry: vi.fn(),
    });

    vi.mocked(useFearAndGreed).mockReturnValue({
      data: {
        sentiment: {
          fearGreedIndex: 65,
          label: 'Greed',
        },
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    vi.mocked(useLatestNews).mockReturnValue({
      data: {
        articles: [
          {
            id: '1',
            title: 'Sample headline',
            url: 'https://example.com/1',
            source: 'Source',
            body: '',
            categories: 'BTC',
            publishedOn: Date.now(),
            imageUrl: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);
  });

  it('renders the hidden h1 and each section landmark text', () => {
    render(<MarketHome />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Market' });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveClass('sr-only');

    expect(screen.getByRole('tablist', { name: 'Watchlist' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Price hero' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Market chart' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Lab' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Price score' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo', { name: 'Market footer' })).toBeInTheDocument();
  });
});
