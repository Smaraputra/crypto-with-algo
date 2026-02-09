import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HoldingsList } from './HoldingsList';

const mockUsePortfolio = vi.fn();
const mockUseRemoveHolding = vi.fn();
const mockUseBinanceTicker = vi.fn();
const mockUseTickers = vi.fn();

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: (...args: unknown[]) => mockUsePortfolio(...args),
  useRemoveHolding: (...args: unknown[]) => mockUseRemoveHolding(...args),
}));

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: (...args: unknown[]) => mockUseBinanceTicker(...args),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: () => mockUseTickers(),
}));

const mockHoldings = [
  {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    quantity: 0.5,
    avgBuyPrice: 40000,
    transactions: [],
  },
  {
    symbol: 'ETHUSDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    quantity: 2.0,
    avgBuyPrice: 2500,
    transactions: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockUseRemoveHolding.mockReturnValue({ mutate: vi.fn() });
  mockUseBinanceTicker.mockReturnValue({ tickers: {}, isConnected: false });
  mockUseTickers.mockReturnValue({ data: [] });
});

describe('HoldingsList', () => {
  it('returns null when portfolioId is null', () => {
    mockUsePortfolio.mockReturnValue({ data: null, isLoading: false });

    const { container } = render(<HoldingsList portfolioId={null} />);

    expect(container.innerHTML).toBe('');
  });

  it('shows loading skeleton when loading', () => {
    mockUsePortfolio.mockReturnValue({ data: null, isLoading: true });

    render(<HoldingsList portfolioId="p1" />);

    expect(screen.getByTestId('holdings-skeleton')).toBeInTheDocument();
  });

  it('has aria-live on loading skeleton', () => {
    mockUsePortfolio.mockReturnValue({ data: null, isLoading: true });

    render(<HoldingsList portfolioId="p1" />);

    const skeleton = screen.getByTestId('holdings-skeleton');
    expect(skeleton).toHaveAttribute('aria-live', 'polite');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  it('shows empty state when no holdings', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: [] } },
      isLoading: false,
    });

    render(<HoldingsList portfolioId="p1" />);

    expect(screen.getByTestId('holdings-empty')).toBeInTheDocument();
  });

  it('renders table with correct headers', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: mockHoldings } },
      isLoading: false,
    });

    render(<HoldingsList portfolioId="p1" />);

    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Quantity')).toBeInTheDocument();
    expect(screen.getByText('Avg Buy')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('renders correct row count', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: mockHoldings } },
      isLoading: false,
    });

    render(<HoldingsList portfolioId="p1" />);

    const table = screen.getByTestId('holdings-table');
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
  });

  it('displays symbol with base/quote', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: mockHoldings } },
      isLoading: false,
    });

    render(<HoldingsList portfolioId="p1" />);

    // Both desktop table and mobile cards render, so use getAllByText
    expect(screen.getAllByText('BTC').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('ETH').length).toBeGreaterThanOrEqual(1);
  });

  it('shows current price from ticker data', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: mockHoldings } },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({
      data: [
        { symbol: 'BTCUSDT', lastPrice: '50000.00', openPrice: '48000.00' },
        { symbol: 'ETHUSDT', lastPrice: '3000.00', openPrice: '2800.00' },
      ],
    });

    render(<HoldingsList portfolioId="p1" />);

    // Both desktop and mobile render prices, use getAllByText
    expect(screen.getAllByText('$50,000.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$3,000.00').length).toBeGreaterThanOrEqual(1);
  });

  it('uses monospace font for numbers', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: mockHoldings } },
      isLoading: false,
    });

    render(<HoldingsList portfolioId="p1" />);

    const monoElements = screen.getByTestId('holdings-table').querySelectorAll('.font-mono');
    expect(monoElements.length).toBeGreaterThan(0);
  });

  it('shows P&L with correct colors', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: mockHoldings } },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({
      data: [
        { symbol: 'BTCUSDT', lastPrice: '50000.00', openPrice: '48000.00' },
        { symbol: 'ETHUSDT', lastPrice: '2000.00', openPrice: '2800.00' },
      ],
    });

    render(<HoldingsList portfolioId="p1" />);

    // BTC is profitable: green
    const greenElements = screen.getByTestId('holdings-table').querySelectorAll('.text-bullish');
    expect(greenElements.length).toBeGreaterThan(0);

    // ETH is at a loss: red
    const redElements = screen.getByTestId('holdings-table').querySelectorAll('.text-bearish');
    expect(redElements.length).toBeGreaterThan(0);
  });

  it('shows allocation percentages', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: mockHoldings } },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({
      data: [
        { symbol: 'BTCUSDT', lastPrice: '50000.00', openPrice: '48000.00' },
        { symbol: 'ETHUSDT', lastPrice: '3000.00', openPrice: '2800.00' },
      ],
    });

    render(<HoldingsList portfolioId="p1" />);

    const table = screen.getByTestId('holdings-table');
    expect(table.textContent).toContain('%');
  });

  it('renders action buttons for each row', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: [mockHoldings[0]] } },
      isLoading: false,
    });

    render(<HoldingsList portfolioId="p1" />);

    expect(screen.getByLabelText('Record transaction for BTCUSDT')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove BTCUSDT')).toBeInTheDocument();
  });

  it('shows -- for price when no ticker data', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: [mockHoldings[0]] } },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({ data: [] });

    render(<HoldingsList portfolioId="p1" />);

    const table = screen.getByTestId('holdings-table');
    expect(table.textContent).toContain('--');
  });
});
