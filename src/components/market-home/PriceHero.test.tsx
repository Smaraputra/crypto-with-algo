import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceHero } from './PriceHero';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(),
}));
vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));

describe('PriceHero', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ selectedSymbol: 'ETHUSDT' });
    vi.mocked(useTickers).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useTickers>);
  });

  it('shows placeholder before data arrives and never shows $0', () => {
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: false,
      status: 'connecting',
      lastMessageAt: null,
      retry: vi.fn(),
    });

    render(<PriceHero />);

    expect(screen.getByTestId('price-placeholder')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getByText('ETH / USDT')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Study this coin' });
    expect(link).toHaveAttribute('href', '/focus?symbol=ETHUSDT');
  });

  it('renders the price from the ticker and links to /focus?symbol=ETHUSDT', () => {
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        ETHUSDT: {
          symbol: 'ETHUSDT',
          lastPrice: '3456.78',
          priceChange: '45.10',
          priceChangePercent: '1.32',
          highPrice: '3500',
          lowPrice: '3400',
          volume: '1000',
          quoteVolume: '3456780',
          openPrice: '3411.68',
          count: 500,
        },
      },
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });

    render(<PriceHero />);

    expect(screen.getByTestId('price-value')).toHaveTextContent('$3,456.78');
    expect(screen.getByTestId('price-change')).toHaveTextContent('+1.32%');
    expect(screen.getByTestId('price-change')).toHaveClass('text-up');
    expect(screen.getByText('ETH / USDT')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Study this coin' });
    expect(link).toHaveAttribute('href', '/focus?symbol=ETHUSDT');
  });
});
