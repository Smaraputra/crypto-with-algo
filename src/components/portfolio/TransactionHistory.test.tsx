import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransactionHistory } from './TransactionHistory';

const mockUseTransactions = vi.fn();

vi.mock('@/hooks/usePortfolio', () => ({
  useTransactions: (...args: unknown[]) => mockUseTransactions(...args),
}));

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  portfolioId: 'p1',
  symbol: 'BTCUSDT',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TransactionHistory', () => {
  it('shows loading skeleton when loading', () => {
    mockUseTransactions.mockReturnValue({ data: null, isLoading: true });

    render(<TransactionHistory {...defaultProps} />);

    expect(screen.getByTestId('tx-history-skeleton')).toBeInTheDocument();
  });

  it('shows empty state when no transactions', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [] },
      isLoading: false,
    });

    render(<TransactionHistory {...defaultProps} />);

    expect(screen.getByTestId('tx-history-empty')).toBeInTheDocument();
  });

  it('renders transaction table with rows', () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [
          { _id: 'tx1', type: 'buy', quantity: 0.5, price: 40000, date: '2024-01-15', fee: 10, notes: 'First buy' },
          { _id: 'tx2', type: 'sell', quantity: 0.1, price: 45000, date: '2024-02-01', fee: 5 },
        ],
      },
      isLoading: false,
    });

    render(<TransactionHistory {...defaultProps} />);

    const table = screen.getByTestId('tx-history-table');
    expect(table).toBeInTheDocument();
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
  });

  it('shows buy/sell badges with correct text', () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [
          { _id: 'tx1', type: 'buy', quantity: 0.5, price: 40000, date: '2024-01-15' },
          { _id: 'tx2', type: 'sell', quantity: 0.1, price: 45000, date: '2024-02-01' },
        ],
      },
      isLoading: false,
    });

    render(<TransactionHistory {...defaultProps} />);

    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('SELL')).toBeInTheDocument();
  });

  it('shows title with symbol', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [] },
      isLoading: false,
    });

    render(<TransactionHistory {...defaultProps} />);

    expect(screen.getByText('Transaction History - BTCUSDT')).toBeInTheDocument();
  });
});
