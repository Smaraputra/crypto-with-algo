import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Symbol } from '@/types/market';

// cmdk uses ResizeObserver and scrollIntoView internally
class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);
Element.prototype.scrollIntoView = vi.fn();

const mockSetSelectedSymbol = vi.fn();
const mockSymbols: Symbol[] = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
  { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
];

let mockUseSymbolsReturn = {
  data: mockSymbols as Symbol[] | undefined,
  isLoading: false,
};

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: () => mockUseSymbolsReturn,
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      setSelectedSymbol: mockSetSelectedSymbol,
    }),
}));

import { SymbolSearch } from './SymbolSearch';

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSymbolsReturn = { data: mockSymbols, isLoading: false };
});

describe('SymbolSearch', () => {
  it('renders search button with label', () => {
    render(<SymbolSearch />);
    expect(screen.getByLabelText('Search trading pairs')).toBeInTheDocument();
  });

  it('renders keyboard shortcut hint', () => {
    render(<SymbolSearch />);
    expect(screen.getByText('K')).toBeInTheDocument();
  });

  it('opens dialog when search button is clicked', async () => {
    const user = userEvent.setup();
    render(<SymbolSearch />);

    await user.click(screen.getByLabelText('Search trading pairs'));

    expect(screen.getByPlaceholderText(/search symbol/i)).toBeInTheDocument();
  });

  it('opens dialog on Cmd+K', async () => {
    render(<SymbolSearch />);

    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search symbol/i)).toBeInTheDocument();
    });
  });

  it('displays symbol list when dialog is open', async () => {
    const user = userEvent.setup();
    render(<SymbolSearch />);

    await user.click(screen.getByLabelText('Search trading pairs'));

    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('SOL')).toBeInTheDocument();
  });

  it('shows loading text when symbols are loading', async () => {
    mockUseSymbolsReturn = { data: undefined, isLoading: true };
    const user = userEvent.setup();
    render(<SymbolSearch />);

    await user.click(screen.getByLabelText('Search trading pairs'));

    // Type something that won't match to trigger the empty state
    const input = screen.getByPlaceholderText(/search symbol/i);
    await user.type(input, 'zzzzzzz');

    await waitFor(() => {
      expect(screen.getByText('Loading symbols...')).toBeInTheDocument();
    });
  });

  it('calls setSelectedSymbol and closes dialog on selection', async () => {
    const user = userEvent.setup();
    render(<SymbolSearch />);

    await user.click(screen.getByLabelText('Search trading pairs'));
    await user.click(screen.getByText('BTC'));

    expect(mockSetSelectedSymbol).toHaveBeenCalledWith('BTCUSDT');
  });
});
