import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldingsTable } from './HoldingsTable';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { useRemoveHolding } from '@/hooks/usePortfolio';
import type { Holding } from '@/types/portfolio';

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));

vi.mock('@/hooks/usePortfolio', () => ({
  useRemoveHolding: vi.fn(),
  useAddHolding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useRecordTransaction: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: vi.fn(() => ({ data: [], isLoading: false })),
}));

describe('HoldingsTable', () => {
  const mockHoldings: Holding[] = [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      quantity: 1.5,
      avgBuyPrice: 60000,
      transactions: [],
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      quantity: 5,
      avgBuyPrice: 3000,
      transactions: [],
    },
  ];

  const removeHoldingMutateAsync = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '65000.00',
          priceChange: '1000',
          priceChangePercent: '1.5',
          highPrice: '66000',
          lowPrice: '64000',
          volume: '100',
          quoteVolume: '6500000',
          openPrice: '64000',
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
          lastPrice: '3200.00',
          priceChange: '50',
          priceChangePercent: '1.5',
          highPrice: '3300',
          lowPrice: '3100',
          volume: '200',
          quoteVolume: '640000',
          openPrice: '3150',
          count: 30,
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useTickers>);

    vi.mocked(useRemoveHolding).mockReturnValue({
      mutateAsync: removeHoldingMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useRemoveHolding>);
  });

  it('renders empty state when holdings is empty', () => {
    render(<HoldingsTable portfolioId="port-1" holdings={[]} />);

    expect(
      screen.getByText('No holdings yet. Add your first coin.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a holding' })).toBeInTheDocument();
  });

  it('renders table with caption, rows, and links to /focus?symbol=', () => {
    render(<HoldingsTable portfolioId="port-1" holdings={mockHoldings} />);

    // Table caption
    const caption = screen.getByText('Portfolio holdings');
    expect(caption).toBeInTheDocument();
    expect(caption.tagName.toLowerCase()).toBe('caption');

    // /focus links
    const btcLinks = screen.getAllByRole('link', { name: 'BTC' });
    expect(btcLinks.length).toBeGreaterThanOrEqual(1);
    expect(btcLinks[0]).toHaveAttribute('href', '/focus?symbol=BTCUSDT');

    const ethLinks = screen.getAllByRole('link', { name: 'ETH' });
    expect(ethLinks.length).toBeGreaterThanOrEqual(1);
    expect(ethLinks[0]).toHaveAttribute('href', '/focus?symbol=ETHUSDT');
  });

  it('opens actions menu and calls remove holding after confirmation dialog', async () => {
    const user = userEvent.setup();
    removeHoldingMutateAsync.mockResolvedValueOnce({});

    render(<HoldingsTable portfolioId="port-1" holdings={mockHoldings} />);

    // Click actions button for BTC
    const btcActionBtn = screen.getAllByRole('button', { name: 'Actions for BTC' })[0];
    await user.click(btcActionBtn);

    // Click "Remove holding" in menu
    const removeMenuItem = await screen.findByRole('menuitem', { name: 'Remove holding' });
    await user.click(removeMenuItem);

    // Confirmation dialog appears
    expect(
      screen.getByText('Are you sure you want to remove BTC from this portfolio? This action cannot be undone.')
    ).toBeInTheDocument();

    // Confirm remove
    const confirmBtn = screen.getByRole('button', { name: 'Remove' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(removeHoldingMutateAsync).toHaveBeenCalledWith('BTCUSDT');
    });
  });

  it('opens trade sheet in record mode from actions menu', async () => {
    const user = userEvent.setup();
    render(<HoldingsTable portfolioId="port-1" holdings={mockHoldings} />);

    const btcActionBtn = screen.getAllByRole('button', { name: 'Actions for BTC' })[0];
    await user.click(btcActionBtn);

    const recordMenuItem = await screen.findByRole('menuitem', { name: 'Record a trade' });
    await user.click(recordMenuItem);

    expect(screen.getByText('Record a trade')).toBeInTheDocument();
  });
});
