import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAddSymbol = vi.fn();
const mockRemoveSymbol = vi.fn();
let mockWatchlistData = { symbols: ['BTCUSDT', 'ETHUSDT'], isLoading: false };

vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => ({
    ...mockWatchlistData,
    addSymbol: mockAddSymbol,
    removeSymbol: mockRemoveSymbol,
  }),
}));

let mockTickers: Record<string, { lastPrice: string; priceChangePercent: string }> = {};

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: () => ({ tickers: mockTickers }),
}));

let mockSelectedSymbol = 'BTCUSDT';
const mockSetSelectedSymbol = vi.fn();

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedSymbol: mockSelectedSymbol,
      setSelectedSymbol: mockSetSelectedSymbol,
    }),
}));

import { WatchlistSidebar } from './WatchlistSidebar';

beforeEach(() => {
  vi.clearAllMocks();
  mockWatchlistData = { symbols: ['BTCUSDT', 'ETHUSDT'], isLoading: false };
  mockTickers = {};
  mockSelectedSymbol = 'BTCUSDT';
});

describe('WatchlistSidebar', () => {
  it('renders loading skeleton when isLoading', () => {
    mockWatchlistData = { symbols: [], isLoading: true };
    const { container } = render(<WatchlistSidebar />);
    const shimmers = container.querySelectorAll('.animate-shimmer');
    expect(shimmers).toHaveLength(3);
  });

  it('renders watchlist header with star icon', () => {
    render(<WatchlistSidebar />);
    expect(screen.getByText('Watchlist')).toBeInTheDocument();
  });

  it('renders symbol names from watchlist', () => {
    render(<WatchlistSidebar />);
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
  });

  it('renders live price and 24h change for each symbol', () => {
    mockTickers = {
      BTCUSDT: { lastPrice: '40500.00', priceChangePercent: '1.25' },
      ETHUSDT: { lastPrice: '2550.00', priceChangePercent: '-2.50' },
    };
    render(<WatchlistSidebar />);
    expect(screen.getByText('$40,500')).toBeInTheDocument();
    expect(screen.getByText('+1.3%')).toBeInTheDocument();
    expect(screen.getByText('$2,550')).toBeInTheDocument();
    expect(screen.getByText('-2.5%')).toBeInTheDocument();
  });

  it('applies bullish/bearish color classes', () => {
    mockTickers = {
      BTCUSDT: { lastPrice: '40500.00', priceChangePercent: '1.25' },
      ETHUSDT: { lastPrice: '2550.00', priceChangePercent: '-2.50' },
    };
    render(<WatchlistSidebar />);
    const bullish = screen.getByText('+1.3%');
    expect(bullish.className).toContain('text-bullish');
    const bearish = screen.getByText('-2.5%');
    expect(bearish.className).toContain('text-bearish');
  });

  it('highlights selected symbol', () => {
    mockSelectedSymbol = 'BTCUSDT';
    render(<WatchlistSidebar />);
    const btcRow = screen.getByText('BTC').closest('[role="button"]');
    expect(btcRow?.className).toMatch(/(?<!\S)bg-sidebar-accent(?!\S|\/)/);

    const ethRow = screen.getByText('ETH').closest('[role="button"]');
    expect(ethRow?.className).not.toMatch(/(?<!\S)bg-sidebar-accent(?!\S|\/)/);
  });

  it('calls setSelectedSymbol on symbol click', () => {
    render(<WatchlistSidebar />);
    const ethRow = screen.getByText('ETH').closest('[role="button"]');
    fireEvent.click(ethRow!);
    expect(mockSetSelectedSymbol).toHaveBeenCalledWith('ETHUSDT');
  });

  it('calls removeSymbol on remove button click', () => {
    render(<WatchlistSidebar />);
    // Each symbol row has a remove button (X icon inside a Button)
    // There are 2 symbols, so 2 remove buttons (+ the add button = 3 total buttons in non-loading state)
    const buttons = screen.getAllByRole('button');
    // Find the remove buttons - they're inside the symbol rows
    const removeButtons = buttons.filter((btn) =>
      btn.className.includes('opacity-0')
    );
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[0]);
    expect(mockRemoveSymbol).toHaveBeenCalledWith('BTCUSDT');
  });

  it('shows empty state when symbols array is empty', () => {
    mockWatchlistData = { symbols: [], isLoading: false };
    render(<WatchlistSidebar />);
    expect(screen.getByText('No symbols in watchlist')).toBeInTheDocument();
  });

  it('renders add button with dropdown trigger', () => {
    render(<WatchlistSidebar />);
    // The plus button is a DropdownMenuTrigger
    const buttons = screen.getAllByRole('button');
    const addButton = buttons.find((btn) =>
      btn.className.includes('h-6') && btn.className.includes('w-6')
    );
    expect(addButton).toBeDefined();
  });
});
