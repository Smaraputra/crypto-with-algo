import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinTabs } from './CoinTabs';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
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

describe('CoinTabs', () => {
  const setSelectedSymbolMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      selectedSymbol: 'BTCUSDT',
      setSelectedSymbol: setSelectedSymbolMock,
    });
    vi.mocked(useTickers).mockReturnValue({
      data: [
        {
          symbol: 'SOLUSDT',
          lastPrice: '145.20',
          priceChange: '-2.10',
          priceChangePercent: '-1.43',
          highPrice: '150',
          lowPrice: '140',
          volume: '1000',
          quoteVolume: '145200',
          openPrice: '147.30',
          count: 500,
        },
      ],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useTickers>);
  });

  it('renders tabs from the watchlist, signed change, and aria-selected follows selectedSymbol', () => {
    vi.mocked(useWatchlist).mockReturnValue({
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      isLoading: false,
      addSymbol: vi.fn(),
      removeSymbol: vi.fn(),
    });

    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '67420.50',
          priceChange: '800',
          priceChangePercent: '1.20',
          highPrice: '68000',
          lowPrice: '66000',
          volume: '2000',
          quoteVolume: '134000000',
          openPrice: '66620.50',
          count: 1000,
        },
        ETHUSDT: {
          symbol: 'ETHUSDT',
          lastPrice: '3500.00',
          priceChange: '-30',
          priceChangePercent: '-0.84',
          highPrice: '3600',
          lowPrice: '3450',
          volume: '5000',
          quoteVolume: '17500000',
          openPrice: '3530',
          count: 800,
        },
      },
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });

    render(<CoinTabs />);

    const tablist = screen.getByRole('tablist', { name: 'Watchlist' });
    expect(tablist).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);

    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveTextContent('BTC');
    expect(tabs[0]).toHaveTextContent('+1.20%');

    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveTextContent('ETH');
    expect(tabs[1]).toHaveTextContent('-0.84%');

    // SOL comes from fallback useTickers
    expect(tabs[2]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[2]).toHaveTextContent('SOL');
    expect(tabs[2]).toHaveTextContent('-1.43%');
  });

  it('click and ArrowRight call setSelectedSymbol', async () => {
    const user = userEvent.setup();
    vi.mocked(useWatchlist).mockReturnValue({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      isLoading: false,
      addSymbol: vi.fn(),
      removeSymbol: vi.fn(),
    });
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });

    render(<CoinTabs />);
    const tabs = screen.getAllByRole('tab');

    expect(tabs[0]).toHaveAccessibleName('BTC');
    expect(tabs[0]).not.toHaveTextContent('+0.00%');
    expect(tabs[0]).not.toHaveTextContent('$0');

    await user.click(tabs[1]);
    expect(setSelectedSymbolMock).toHaveBeenCalledWith('ETHUSDT');

    tabs[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(setSelectedSymbolMock).toHaveBeenCalledWith('ETHUSDT');
  });

  it('shows placeholder block and base asset accessible name with no +0.00% or $0 when ticker is missing', () => {
    vi.mocked(useWatchlist).mockReturnValue({
      symbols: ['BTCUSDT'],
      isLoading: false,
      addSymbol: vi.fn(),
      removeSymbol: vi.fn(),
    });
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });

    render(<CoinTabs />);
    const tab = screen.getByRole('tab', { name: 'BTC' });
    expect(tab).toBeInTheDocument();
    expect(tab).not.toHaveTextContent('+0.00%');
    expect(tab).not.toHaveTextContent('$0');
    expect(screen.getByTestId('coin-tab-ticker-placeholder')).toBeInTheDocument();
  });

  it('shows empty text when watchlist is empty', () => {
    vi.mocked(useWatchlist).mockReturnValue({
      symbols: [],
      isLoading: false,
      addSymbol: vi.fn(),
      removeSymbol: vi.fn(),
    });
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });

    render(<CoinTabs />);
    expect(
      screen.getByText('Your watchlist is empty. Add coins from search (Ctrl K).')
    ).toBeInTheDocument();
  });

  it('shows three static placeholder tabs when loading', () => {
    vi.mocked(useWatchlist).mockReturnValue({
      symbols: [],
      isLoading: true,
      addSymbol: vi.fn(),
      removeSymbol: vi.fn(),
    });
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: false,
      status: 'connecting',
      lastMessageAt: null,
      retry: vi.fn(),
    });

    render(<CoinTabs />);
    expect(screen.getAllByTestId('coin-tab-placeholder')).toHaveLength(3);
  });

  it('renders placeholder tabs during SSR and real tabs after client hydration when watchlist is loaded', () => {
    vi.mocked(useWatchlist).mockReturnValue({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      isLoading: false,
      addSymbol: vi.fn(),
      removeSymbol: vi.fn(),
    });
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });

    const ssrHtml = renderToString(<CoinTabs />);
    expect(ssrHtml).toContain('coin-tab-placeholder');
    expect(ssrHtml).not.toContain('role="tab"');

    render(<CoinTabs />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAccessibleName('BTC');
    expect(tabs[1]).toHaveAccessibleName('ETH');
  });
});

