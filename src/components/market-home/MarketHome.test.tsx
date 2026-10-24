import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketHome } from './MarketHome';
import { useSession } from 'next-auth/react';
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

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));
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
// The chart's past calls read the track record through React Query; the
// legend's own behaviour is covered in CallsLegend and useChartCalls tests.
vi.mock('@/hooks/useChartCalls', () => ({
  useChartCalls: () => ({
    eligible: false,
    ineligibleReason: 'interval',
    show: true,
    setShow: () => {},
    callsOverlay: { visible: false, calls: new Map(), boundary: null, horizonBars: 0, costPercent: 0 },
    onLoadedRangeChange: () => {},
    onVisibleRangeChange: () => {},
    tally: null,
    loading: false,
    error: false,
  }),
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
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: { id: 'u1', name: 'Smaraputra Doe', email: 'smara@example.com', tosAccepted: true, isAdmin: false },
        expires: '1',
      },
      status: 'authenticated',
      update: vi.fn(),
    });
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

  it('renders the visible h1 Market, welcome line with first name, and each section landmark text', () => {
    render(<MarketHome />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Market' });
    expect(heading).toBeInTheDocument();
    expect(heading).not.toHaveClass('sr-only');
    expect(screen.getByText('Welcome, Smaraputra.')).toBeInTheDocument();

    expect(screen.getByRole('tablist', { name: 'Watchlist' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Price hero' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Market chart' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Lab' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Price score' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo', { name: 'Market footer' })).toBeInTheDocument();
  });

  it('renders no welcome line when session has no user name', () => {
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn(),
    });

    render(<MarketHome />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Market' });
    expect(heading).toBeInTheDocument();
    expect(heading).not.toHaveClass('sr-only');
    expect(screen.queryByText(/Welcome/)).not.toBeInTheDocument();
  });

  it('does not double the full stop when the first name ends in one', () => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { name: 'A.A. Smara' }, expires: '' },
      status: 'authenticated',
      update: vi.fn(),
    } as unknown as ReturnType<typeof useSession>);

    render(<MarketHome />);

    expect(screen.getByText('Welcome, A.A.')).toBeInTheDocument();
  });

  it('holds the welcome line with a blank line while the session loads, so nothing shifts', () => {
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'loading',
      update: vi.fn(),
    });

    render(<MarketHome />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Market' });
    const placeholder = heading.parentElement?.querySelector('p');
    expect(placeholder?.textContent).toBe('\u00a0');
    expect(screen.queryByText(/Welcome/)).not.toBeInTheDocument();
  });

  it('does not set double gutters or max-width classes, delegating to layout', () => {
    const { container } = render(<MarketHome />);
    const root = container.firstElementChild;
    expect(root).toHaveClass('flex', 'flex-col', 'gap-6');
    expect(root).not.toHaveClass('max-w-7xl');
    expect(root).not.toHaveClass('px-4');
  });
});
