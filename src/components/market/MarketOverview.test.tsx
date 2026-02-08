import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mockTickers } from '@/__fixtures__/binance';
import type { Ticker24h } from '@/types/market';

// Mock hooks and store
const mockUseTickers = vi.fn();
const mockUseBinanceTicker = vi.fn();
const mockSetSelectedSymbol = vi.fn();
const mockUseUIStore = vi.fn();

vi.mock('@/hooks/usePrices', () => ({
  useTickers: () => mockUseTickers(),
}));

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: () => mockUseBinanceTicker(),
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    mockUseUIStore(selector),
}));

import { MarketOverview, DEFAULT_SYMBOLS } from './MarketOverview';

describe('MarketOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUIStore.mockImplementation(
      (selector: (s: Record<string, unknown>) => unknown) =>
        selector({
          selectedSymbol: 'BTCUSDT',
          setSelectedSymbol: mockSetSelectedSymbol,
        })
    );
    mockUseBinanceTicker.mockReturnValue({ tickers: {}, isConnected: false });
  });

  it('exports DEFAULT_SYMBOLS with 8 entries', () => {
    expect(DEFAULT_SYMBOLS).toHaveLength(8);
    expect(DEFAULT_SYMBOLS).toContain('BTCUSDT');
    expect(DEFAULT_SYMBOLS).toContain('AVAXUSDT');
  });

  it('shows 8 loading skeletons when isLoading', () => {
    mockUseTickers.mockReturnValue({ data: undefined, isLoading: true });

    const { container } = render(<MarketOverview />);
    const shimmers = container.querySelectorAll('.animate-shimmer');
    expect(shimmers).toHaveLength(8);
  });

  it('renders price cards after data loads', () => {
    mockUseTickers.mockReturnValue({ data: mockTickers, isLoading: false });

    render(<MarketOverview />);
    expect(screen.getByText('BTC/USDT')).toBeInTheDocument();
    expect(screen.getByText('ETH/USDT')).toBeInTheDocument();
  });

  it('merges live data over REST data', () => {
    const liveTicker: Ticker24h = {
      ...mockTickers[0],
      lastPrice: '99999.00',
    };
    mockUseTickers.mockReturnValue({ data: mockTickers, isLoading: false });
    mockUseBinanceTicker.mockReturnValue({
      tickers: { BTCUSDT: liveTicker },
      isConnected: true,
    });

    render(<MarketOverview />);
    // Live price should be displayed, not REST price
    expect(screen.getByText('$99,999')).toBeInTheDocument();
    expect(screen.queryByText('$40,500')).not.toBeInTheDocument();
  });

  it('falls back to REST when live unavailable', () => {
    mockUseTickers.mockReturnValue({ data: mockTickers, isLoading: false });
    mockUseBinanceTicker.mockReturnValue({ tickers: {}, isConnected: false });

    render(<MarketOverview />);
    expect(screen.getByText('$40,500')).toBeInTheDocument();
  });

  it('calls setSelectedSymbol on click', async () => {
    const user = userEvent.setup();
    mockUseTickers.mockReturnValue({ data: mockTickers, isLoading: false });

    render(<MarketOverview />);
    await user.click(screen.getByText('ETH/USDT'));
    expect(mockSetSelectedSymbol).toHaveBeenCalledWith('ETHUSDT');
  });

  it('shows live indicator when connected and live data exists', () => {
    const liveTicker: Ticker24h = { ...mockTickers[0] };
    mockUseTickers.mockReturnValue({ data: mockTickers, isLoading: false });
    mockUseBinanceTicker.mockReturnValue({
      tickers: { BTCUSDT: liveTicker },
      isConnected: true,
    });

    const { container } = render(<MarketOverview />);
    const dots = container.querySelectorAll('.bg-bullish.animate-pulse');
    // Only BTC has live data, so exactly 1 dot
    expect(dots).toHaveLength(1);
  });
});
