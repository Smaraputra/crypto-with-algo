import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PortfolioSummary } from './PortfolioSummary';

const mockUsePortfolio = vi.fn();
const mockUseBinanceTicker = vi.fn();
const mockUseTickers = vi.fn();

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: (...args: unknown[]) => mockUsePortfolio(...args),
}));

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: (...args: unknown[]) => mockUseBinanceTicker(...args),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: () => mockUseTickers(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockUseBinanceTicker.mockReturnValue({ tickers: {}, isConnected: false });
  mockUseTickers.mockReturnValue({ data: [] });
});

describe('PortfolioSummary', () => {
  it('returns null when portfolioId is null', () => {
    mockUsePortfolio.mockReturnValue({ data: null, isLoading: false });

    const { container } = render(<PortfolioSummary portfolioId={null} />);

    expect(container.innerHTML).toBe('');
  });

  it('shows loading skeleton when loading', () => {
    mockUsePortfolio.mockReturnValue({ data: null, isLoading: true });

    render(<PortfolioSummary portfolioId="p1" />);

    expect(screen.getByTestId('summary-skeleton')).toBeInTheDocument();
  });

  it('shows empty state when no holdings', () => {
    mockUsePortfolio.mockReturnValue({
      data: { portfolio: { _id: 'p1', holdings: [] } },
      isLoading: false,
    });

    render(<PortfolioSummary portfolioId="p1" />);

    expect(screen.getByTestId('summary-empty')).toBeInTheDocument();
    expect(screen.getByText(/no holdings yet/i)).toBeInTheDocument();
  });

  it('calculates and displays total value', () => {
    mockUsePortfolio.mockReturnValue({
      data: {
        portfolio: {
          _id: 'p1',
          holdings: [
            { symbol: 'BTCUSDT', quantity: 0.5, avgBuyPrice: 40000, transactions: [] },
          ],
        },
      },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({
      data: [{ symbol: 'BTCUSDT', lastPrice: '50000.00', openPrice: '48000.00' }],
    });

    render(<PortfolioSummary portfolioId="p1" />);

    expect(screen.getByTestId('portfolio-summary')).toBeInTheDocument();
    expect(screen.getByText('Total Value')).toBeInTheDocument();
    expect(screen.getByText('$25,000.00')).toBeInTheDocument();
  });

  it('displays P&L with correct color for profit', () => {
    mockUsePortfolio.mockReturnValue({
      data: {
        portfolio: {
          _id: 'p1',
          holdings: [
            { symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 40000, transactions: [] },
          ],
        },
      },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({
      data: [{ symbol: 'BTCUSDT', lastPrice: '50000.00', openPrice: '48000.00' }],
    });

    render(<PortfolioSummary portfolioId="p1" />);

    expect(screen.getByText('Total P&L')).toBeInTheDocument();
    expect(screen.getByText('$10,000.00')).toBeInTheDocument();
    expect(screen.getByText('+25.00%')).toBeInTheDocument();
  });

  it('displays 24h change', () => {
    mockUsePortfolio.mockReturnValue({
      data: {
        portfolio: {
          _id: 'p1',
          holdings: [
            { symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 40000, transactions: [] },
          ],
        },
      },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({
      data: [{ symbol: 'BTCUSDT', lastPrice: '50000.00', openPrice: '48000.00' }],
    });

    render(<PortfolioSummary portfolioId="p1" />);

    expect(screen.getByText('24h Change')).toBeInTheDocument();
    expect(screen.getByText('$2,000.00')).toBeInTheDocument();
  });

  it('uses monospace font for numbers', () => {
    mockUsePortfolio.mockReturnValue({
      data: {
        portfolio: {
          _id: 'p1',
          holdings: [
            { symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 40000, transactions: [] },
          ],
        },
      },
      isLoading: false,
    });
    mockUseTickers.mockReturnValue({
      data: [{ symbol: 'BTCUSDT', lastPrice: '50000.00', openPrice: '48000.00' }],
    });

    render(<PortfolioSummary portfolioId="p1" />);

    const valueElements = screen.getByTestId('portfolio-summary').querySelectorAll('.font-mono');
    expect(valueElements.length).toBeGreaterThan(0);
  });
});
