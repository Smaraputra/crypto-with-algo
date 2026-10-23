import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PriceStrip } from './PriceStrip';
import * as pricesHook from '@/hooks/usePrices';
import type { Ticker24h } from '@/types/market';

vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));

const mockTickers: Ticker24h[] = [
  {
    symbol: 'BTCUSDT',
    lastPrice: '67450.50',
    priceChange: '1200.50',
    priceChangePercent: '1.81',
    highPrice: '68000',
    lowPrice: '66000',
    volume: '25000',
    quoteVolume: '1680000000',
    openPrice: '66250',
    count: 100000,
  },
  {
    symbol: 'ETHUSDT',
    lastPrice: '3450.25',
    priceChange: '-85.25',
    priceChangePercent: '-2.41',
    highPrice: '3550',
    lowPrice: '3400',
    volume: '150000',
    quoteVolume: '517000000',
    openPrice: '3535.50',
    count: 80000,
  },
  {
    symbol: 'SOLUSDT',
    lastPrice: '150.00',
    priceChange: '0.00',
    priceChangePercent: '0.00',
    highPrice: '155',
    lowPrice: '148',
    volume: '500000',
    quoteVolume: '75000000',
    openPrice: '150',
    count: 40000,
  },
];

describe('PriceStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders base assets with signed and coloured price changes', () => {
    vi.mocked(pricesHook.useTickers).mockReturnValue({
      data: mockTickers,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof pricesHook.useTickers>);

    render(<PriceStrip />);

    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('$67,450.50')).toBeInTheDocument();
    const btcChange = screen.getByText('+1.81%');
    expect(btcChange).toBeInTheDocument();
    expect(btcChange).toHaveClass('text-up');

    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('$3,450.25')).toBeInTheDocument();
    const ethChange = screen.getByText('-2.41%');
    expect(ethChange).toBeInTheDocument();
    expect(ethChange).toHaveClass('text-down');

    expect(screen.getByText('SOL')).toBeInTheDocument();
    expect(screen.getByText('0.00%')).toBeInTheDocument();
  });

  it('renders nothing on error', () => {
    vi.mocked(pricesHook.useTickers).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network error'),
    } as unknown as ReturnType<typeof pricesHook.useTickers>);

    const { container } = render(<PriceStrip />);
    expect(container.firstChild).toBeNull();
  });

  it('renders grey placeholder blocks while loading', () => {
    vi.mocked(pricesHook.useTickers).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof pricesHook.useTickers>);

    render(<PriceStrip />);
    expect(screen.getByTestId('price-strip-loading')).toBeInTheDocument();
  });
});
