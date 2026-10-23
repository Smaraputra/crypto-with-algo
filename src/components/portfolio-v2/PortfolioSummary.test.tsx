import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioSummary } from './PortfolioSummary';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import type { Holding } from '@/types/portfolio';

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));

describe('PortfolioSummary', () => {
  const mockHoldings: Holding[] = [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      quantity: 2,
      avgBuyPrice: 50000,
      transactions: [],
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      quantity: 10,
      avgBuyPrice: 3000,
      transactions: [],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders placeholders before prices arrive and never $0', () => {
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      isConnected: false,
      status: 'connecting',
      lastMessageAt: null,
      retry: vi.fn(),
    });
    vi.mocked(useTickers).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useTickers>);

    render(<PortfolioSummary holdings={mockHoldings} />);

    expect(screen.getByTestId('portfolio-value-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-cost-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-pnl-placeholder')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('renders total value, total cost and positive P&L with up colour', () => {
    // Total cost = (2 * 50000) + (10 * 3000) = 100,000 + 30,000 = 130,000
    // Live prices: BTC = 60000, ETH = 3500
    // Total value = (2 * 60000) + (10 * 3500) = 120,000 + 35,000 = 155,000
    // PnL = +25,000 (+19.23%)
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '60000.00',
          priceChange: '1000',
          priceChangePercent: '1.7',
          highPrice: '61000',
          lowPrice: '59000',
          volume: '100',
          quoteVolume: '6000000',
          openPrice: '59000',
          count: 50,
        },
      },
      isConnected: true,
      status: 'live',
      lastMessageAt: Date.now(),
      retry: vi.fn(),
    });
    vi.mocked(useTickers).mockReturnValue({
      data: [
        {
          symbol: 'ETHUSDT',
          lastPrice: '3500.00',
          priceChange: '100',
          priceChangePercent: '2.9',
          highPrice: '3600',
          lowPrice: '3400',
          volume: '200',
          quoteVolume: '700000',
          openPrice: '3400',
          count: 30,
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useTickers>);

    render(<PortfolioSummary holdings={mockHoldings} />);

    const valueEl = screen.getByTestId('total-value');
    expect(valueEl).toHaveTextContent('$155,000.00');

    const costEl = screen.getByTestId('total-cost');
    expect(costEl).toHaveTextContent('$130,000.00');

    const pnlEl = screen.getByTestId('unrealized-pnl');
    expect(pnlEl).toHaveTextContent('+$25,000.00 (+19.23%)');
    expect(pnlEl).toHaveClass('text-up');
    expect(pnlEl).not.toHaveClass('text-down');
  });

  it('renders negative P&L with minus sign and down colour', () => {
    // Total cost = 130,000
    // Live prices: BTC = 40000, ETH = 2000
    // Total value = (2 * 40000) + (10 * 2000) = 80,000 + 20,000 = 100,000
    // PnL = -30,000 (-23.08%)
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '40000.00',
          priceChange: '-2000',
          priceChangePercent: '-4.7',
          highPrice: '42000',
          lowPrice: '39000',
          volume: '100',
          quoteVolume: '4000000',
          openPrice: '42000',
          count: 50,
        },
        ETHUSDT: {
          symbol: 'ETHUSDT',
          lastPrice: '2000.00',
          priceChange: '-100',
          priceChangePercent: '-4.8',
          highPrice: '2100',
          lowPrice: '1900',
          volume: '200',
          quoteVolume: '400000',
          openPrice: '2100',
          count: 30,
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
    } as unknown as ReturnType<typeof useTickers>);

    render(<PortfolioSummary holdings={mockHoldings} />);

    const pnlEl = screen.getByTestId('unrealized-pnl');
    expect(pnlEl).toHaveTextContent('-$30,000.00 (-23.08%)');
    expect(pnlEl).toHaveClass('text-down');
    expect(pnlEl).not.toHaveClass('text-up');
  });

  it('renders flat P&L when value equals cost with neutral colour', () => {
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '50000.00',
          priceChange: '0',
          priceChangePercent: '0',
          highPrice: '50000',
          lowPrice: '50000',
          volume: '100',
          quoteVolume: '5000000',
          openPrice: '50000',
          count: 50,
        },
        ETHUSDT: {
          symbol: 'ETHUSDT',
          lastPrice: '3000.00',
          priceChange: '0',
          priceChangePercent: '0',
          highPrice: '3000',
          lowPrice: '3000',
          volume: '200',
          quoteVolume: '600000',
          openPrice: '3000',
          count: 30,
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
    } as unknown as ReturnType<typeof useTickers>);

    render(<PortfolioSummary holdings={mockHoldings} />);

    const pnlEl = screen.getByTestId('unrealized-pnl');
    expect(pnlEl).toHaveTextContent('+$0.00 (+0.00%)');
    expect(pnlEl).toHaveClass('text-muted-foreground');
  });
});
