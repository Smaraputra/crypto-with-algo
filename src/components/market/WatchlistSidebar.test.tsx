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

let mockLevelsData:
  | {
      asOf: string;
      levels: Record<string, import('@/lib/market/levels').PriorDayLevels | null>;
    }
  | undefined = undefined;

vi.mock('@/hooks/useDailyLevels', () => ({
  useDailyLevels: () => ({ data: mockLevelsData }),
}));

let mockSelectedSymbol = 'BTCUSDT';
const mockSetSelectedSymbol = vi.fn();
const mockSetMobileSidebarOpen = vi.fn();

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedSymbol: mockSelectedSymbol,
      setSelectedSymbol: mockSetSelectedSymbol,
      setMobileSidebarOpen: mockSetMobileSidebarOpen,
    }),
}));

import { WatchlistSidebar } from './WatchlistSidebar';

beforeEach(() => {
  vi.clearAllMocks();
  mockWatchlistData = { symbols: ['BTCUSDT', 'ETHUSDT'], isLoading: false };
  mockTickers = {};
  mockLevelsData = undefined;
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

  it('calls setSelectedSymbol and sets mobileSidebarOpen to false on symbol click', () => {
    render(<WatchlistSidebar />);
    const ethRow = screen.getByText('ETH').closest('[role="button"]');
    fireEvent.click(ethRow!);
    expect(mockSetSelectedSymbol).toHaveBeenCalledWith('ETHUSDT');
    expect(mockSetMobileSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('calls setSelectedSymbol and sets mobileSidebarOpen to false on Enter key', () => {
    render(<WatchlistSidebar />);
    const ethRow = screen.getByText('ETH').closest('[role="button"]');
    fireEvent.keyDown(ethRow!, { key: 'Enter' });
    expect(mockSetSelectedSymbol).toHaveBeenCalledWith('ETHUSDT');
    expect(mockSetMobileSidebarOpen).toHaveBeenCalledWith(false);
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

  it('renders level proximity with text-foreground when near level', () => {
    mockTickers = {
      BTCUSDT: { lastPrice: '108', priceChangePercent: '1.0' },
    };
    mockLevelsData = {
      asOf: '2026-10-18T00:00:00.000Z',
      levels: {
        BTCUSDT: {
          high: 110,
          low: 90,
          close: 100,
          atr: 20,
          dayStart: 1776470400000,
        },
      },
    };
    render(<WatchlistSidebar />);
    const levelEl = screen.getByTestId('level-BTCUSDT');
    expect(levelEl).toHaveTextContent('Prev high 0.1 ATR below');
    expect(levelEl.className).toContain('text-foreground');
    expect(levelEl).toHaveAttribute(
      'title',
      "0.1 daily ATR below the prior UTC day's high (110). Descriptive only, not a signal."
    );
  });

  it('renders level proximity with text-muted-foreground/70 when far from level', () => {
    mockTickers = {
      BTCUSDT: { lastPrice: '300', priceChangePercent: '1.0' },
    };
    mockLevelsData = {
      asOf: '2026-10-18T00:00:00.000Z',
      levels: {
        BTCUSDT: {
          high: 110,
          low: 90,
          close: 100,
          atr: 20,
          dayStart: 1776470400000,
        },
      },
    };
    render(<WatchlistSidebar />);
    const levelEl = screen.getByTestId('level-BTCUSDT');
    expect(levelEl).toHaveTextContent('Prev high 9.5 ATR above');
    expect(levelEl.className).toContain('text-muted-foreground/70');
    expect(levelEl).toHaveAttribute(
      'title',
      "9.5 daily ATR above the prior UTC day's high (110). Descriptive only, not a signal."
    );
  });

  it('renders no level element when levels are null for the symbol', () => {
    mockTickers = {
      BTCUSDT: { lastPrice: '108', priceChangePercent: '1.0' },
    };
    mockLevelsData = {
      asOf: '2026-10-18T00:00:00.000Z',
      levels: {
        BTCUSDT: null,
      },
    };
    render(<WatchlistSidebar />);
    expect(screen.queryByTestId('level-BTCUSDT')).toBeNull();
  });

  it('renders at text when distanceAtr is exactly 0', () => {
    mockTickers = {
      BTCUSDT: { lastPrice: '100', priceChangePercent: '0.0' },
    };
    mockLevelsData = {
      asOf: '2026-10-18T00:00:00.000Z',
      levels: {
        BTCUSDT: {
          high: 110,
          low: 90,
          close: 100,
          atr: 20,
          dayStart: 1776470400000,
        },
      },
    };
    render(<WatchlistSidebar />);
    const levelEl = screen.getByTestId('level-BTCUSDT');
    expect(levelEl).toHaveTextContent('Prev close at');
    expect(levelEl.className).toContain('text-foreground');
    expect(levelEl).toHaveAttribute(
      'title',
      "at the prior UTC day's close (100). Descriptive only, not a signal."
    );
  });

  it('has accessible name for remove button and clicking it calls removeSymbol without selecting symbol', () => {
    render(<WatchlistSidebar />);
    const removeBtn = screen.getByRole('button', { name: 'Remove BTC from watchlist' });
    expect(removeBtn).toBeInTheDocument();
    fireEvent.click(removeBtn);
    expect(mockRemoveSymbol).toHaveBeenCalledWith('BTCUSDT');
    expect(mockSetSelectedSymbol).not.toHaveBeenCalled();
  });
});
