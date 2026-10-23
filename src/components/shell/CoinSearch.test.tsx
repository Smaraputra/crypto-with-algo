import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinSearch } from './CoinSearch';

const mockPush = vi.fn();
const mockSetSelectedSymbol = vi.fn();
const mockAddSymbol = vi.fn();
const mockRemoveSymbol = vi.fn();
const mockUseSymbols = vi.fn();
const mockUseWatchlist = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: { setSelectedSymbol: (s: string) => void }) => unknown) =>
    selector({ setSelectedSymbol: mockSetSelectedSymbol }),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: () => mockUseSymbols(),
}));

vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => mockUseWatchlist(),
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const mockSymbols = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
  { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
];

describe('CoinSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseSymbols.mockReturnValue({
      data: mockSymbols,
      isLoading: false,
      isError: false,
    });
    mockUseWatchlist.mockReturnValue({
      symbols: ['BTCUSDT'],
      addSymbol: mockAddSymbol,
      removeSymbol: mockRemoveSymbol,
    });
  });

  it('opens from button click', () => {
    render(<CoinSearch variant="desktop" />);
    const button = screen.getByRole('button', { name: /search coins/i });
    fireEvent.click(button);

    expect(screen.getByPlaceholderText('Search coins...')).toBeInTheDocument();
  });

  it('opens from Ctrl+K keydown and ignores when typing in an input', () => {
    render(
      <div>
        <input data-testid="other-input" />
        <CoinSearch variant="desktop" />
      </div>
    );

    // Ctrl+K inside another input should NOT open
    const input = screen.getByTestId('other-input');
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
    expect(screen.queryByPlaceholderText('Search coins...')).not.toBeInTheDocument();

    // Ctrl+K globally opens
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByPlaceholderText('Search coins...')).toBeInTheDocument();
  });

  it('typing filters symbols, and selecting calls setSelectedSymbol and router.push', () => {
    render(<CoinSearch variant="desktop" />);
    fireEvent.click(screen.getByRole('button', { name: /search coins/i }));

    const searchInput = screen.getByPlaceholderText('Search coins...');
    fireEvent.change(searchInput, { target: { value: 'BTC' } });

    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.queryByText('ETHUSDT')).not.toBeInTheDocument();

    const item = screen.getByText('BTCUSDT');
    fireEvent.click(item);

    expect(mockSetSelectedSymbol).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedSymbol).toHaveBeenCalledWith('BTCUSDT');
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/focus?symbol=BTCUSDT');
  });

  it('renders desktop and icon variants together and opens exactly one dialog on Ctrl+K, then clicking a coin row calls setSelectedSymbol once and router.push once', () => {
    render(
      <div>
        <CoinSearch variant="desktop" />
        <CoinSearch variant="icon" />
      </div>
    );

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const inputs = screen.getAllByPlaceholderText('Search coins...');
    expect(inputs).toHaveLength(1);

    const item = screen.getByText('BTCUSDT');
    fireEvent.click(item);

    expect(mockSetSelectedSymbol).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedSymbol).toHaveBeenCalledWith('BTCUSDT');
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/focus?symbol=BTCUSDT');
  });

  it('the watchlist toggle calls addSymbol or removeSymbol', () => {
    render(<CoinSearch variant="desktop" />);
    fireEvent.click(screen.getByRole('button', { name: /search coins/i }));

    // BTCUSDT is in watchlist -> should show "Remove from watchlist"
    const removeBtn = screen.getByRole('button', { name: 'Remove from watchlist' });
    fireEvent.click(removeBtn);

    expect(mockRemoveSymbol).toHaveBeenCalledWith('BTCUSDT');
    expect(mockSetSelectedSymbol).not.toHaveBeenCalled();

    // ETHUSDT is not in watchlist -> should show "Add to watchlist"
    const addBtns = screen.getAllByRole('button', { name: 'Add to watchlist' });
    fireEvent.click(addBtns[0]);

    expect(mockAddSymbol).toHaveBeenCalledWith('ETHUSDT');
    expect(mockSetSelectedSymbol).not.toHaveBeenCalled();
  });

  it('shows loading, error and empty states', () => {
    // Loading
    mockUseSymbols.mockReturnValue({
      data: null,
      isLoading: true,
      isError: false,
    });
    const { rerender } = render(<CoinSearch variant="desktop" />);
    fireEvent.click(screen.getByRole('button', { name: /search coins/i }));
    expect(screen.getByText('Loading coins.')).toBeInTheDocument();

    // Error
    mockUseSymbols.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
    });
    rerender(<CoinSearch variant="desktop" />);
    expect(screen.getByText('Coins did not load.')).toBeInTheDocument();

    // Empty matches
    mockUseSymbols.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    rerender(<CoinSearch variant="desktop" />);
    expect(screen.getByText('No coins match.')).toBeInTheDocument();
  });
});
