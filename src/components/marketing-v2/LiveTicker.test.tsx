import { render, screen, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTicker } from './LiveTicker';
import { useTickers } from '@/hooks/usePrices';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';

vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(),
}));

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: vi.fn(),
}));

const mockPolledTickers = [
  {
    symbol: 'BTCUSDT',
    lastPrice: '67000.00',
    priceChange: '500.00',
    priceChangePercent: '1.50',
    highPrice: '68000.00',
    lowPrice: '66000.00',
    volume: '1000',
    quoteVolume: '67000000',
    openPrice: '66500.00',
    count: 50000,
  },
  {
    symbol: 'ETHUSDT',
    lastPrice: '3500.00',
    priceChange: '-20.00',
    priceChangePercent: '-0.57',
    highPrice: '3600.00',
    lowPrice: '3450.00',
    volume: '2000',
    quoteVolume: '7000000',
    openPrice: '3520.00',
    count: 40000,
  },
];

describe('LiveTicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTickers).mockReturnValue({
      data: mockPolledTickers,
      isLoading: false,
      isError: false,
      error: null,
    } as never);

    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: true,
      status: 'live',
      lastMessageAt: 1000,
      retry: vi.fn(),
    });

    vi.mocked(useMarketStreamStatus).mockReturnValue({
      isConnected: true,
      status: 'live',
      lastMessageAt: 1000,
      retry: vi.fn(),
    });
  });

  it('rows render from useTickers', () => {
    render(<LiveTicker symbols={['BTCUSDT', 'ETHUSDT']} />);

    const list = screen.getByRole('list', { name: 'Live prices' });
    expect(list).toBeInTheDocument();

    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('$67,000.00')).toBeInTheDocument();
    expect(screen.getByText('+1.50%')).toBeInTheDocument();

    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('$3,500.00')).toBeInTheDocument();
    expect(screen.getByText('-0.57%')).toBeInTheDocument();
  });

  it('a stream value replaces the polled value', () => {
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '68500.00',
          priceChange: '1500.00',
          priceChangePercent: '2.25',
          highPrice: '69000.00',
          lowPrice: '66000.00',
          volume: '1500',
          quoteVolume: '100000000',
          openPrice: '67000.00',
          count: 60000,
        },
      },
      isConnected: true,
      status: 'live',
      lastMessageAt: 1000,
      retry: vi.fn(),
    });

    render(<LiveTicker symbols={['BTCUSDT']} />);

    expect(screen.getByText('$68,500.00')).toBeInTheDocument();
    expect(screen.queryByText('$67,000.00')).not.toBeInTheDocument();
    expect(screen.getByText('+2.25%')).toBeInTheDocument();
  });

  it('no tint on first render', () => {
    render(<LiveTicker symbols={['BTCUSDT']} />);

    const priceEl = screen.getByTestId('ticker-price-BTCUSDT');
    expect(priceEl).not.toHaveClass('bg-up/15');
    expect(priceEl).not.toHaveClass('bg-down/15');
  });

  it('a rise adds the up tint class and a fall the down tint', () => {
    const { rerender } = render(<LiveTicker symbols={['BTCUSDT']} />);
    const priceEl = screen.getByTestId('ticker-price-BTCUSDT');
    expect(priceEl).not.toHaveClass('bg-up/15');

    // Simulate price rise via stream
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '68000.00',
          priceChange: '1000.00',
          priceChangePercent: '1.49',
          highPrice: '68500.00',
          lowPrice: '66000.00',
          volume: '1100',
          quoteVolume: '70000000',
          openPrice: '67000.00',
          count: 55000,
        },
      },
      isConnected: true,
      status: 'live',
      lastMessageAt: 1000,
      retry: vi.fn(),
    });

    act(() => {
      rerender(<LiveTicker symbols={['BTCUSDT']} />);
    });

    expect(priceEl).toHaveClass('bg-up/15');

    // Simulate price fall via stream
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '66000.00',
          priceChange: '-1000.00',
          priceChangePercent: '-1.49',
          highPrice: '68500.00',
          lowPrice: '65500.00',
          volume: '1200',
          quoteVolume: '72000000',
          openPrice: '67000.00',
          count: 56000,
        },
      },
      isConnected: true,
      status: 'live',
      lastMessageAt: 2000,
      retry: vi.fn(),
    });

    act(() => {
      rerender(<LiveTicker symbols={['BTCUSDT']} />);
    });

    expect(priceEl).toHaveClass('bg-down/15');
  });

  it('placeholders while loading', () => {
    vi.mocked(useTickers).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as never);

    render(<LiveTicker symbols={['BTCUSDT', 'ETHUSDT']} />);

    const placeholders = screen.getAllByTestId('ticker-row-placeholder');
    expect(placeholders).toHaveLength(2);
  });

  it('no digits appear while loading (proves nothing is made up)', () => {
    vi.mocked(useTickers).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as never);

    const { container } = render(<LiveTicker symbols={['BTCUSDT', 'ETHUSDT']} />);

    const list = screen.getByRole('list', { name: 'Live prices' });
    expect(list.textContent).not.toMatch(/\d/);
    expect(container.textContent).not.toMatch(/\$\d+/);
  });

  it('the status text for live and not live', () => {
    // Live
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      isConnected: true,
      status: 'live',
      lastMessageAt: 1000,
      retry: vi.fn(),
    });

    const { rerender } = render(<LiveTicker symbols={['BTCUSDT']} />);
    expect(screen.getByText('Live from Binance')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-status-dot')).toHaveClass('bg-up');

    // Not live / reconnecting
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      isConnected: false,
      status: 'reconnecting',
      lastMessageAt: 1000,
      retry: vi.fn(),
    });

    rerender(<LiveTicker symbols={['BTCUSDT']} />);
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-status-dot')).toHaveClass('bg-muted-foreground');
  });
});
