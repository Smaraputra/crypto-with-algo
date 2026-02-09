import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionForm } from './TransactionForm';

const mockAddHoldingMutate = vi.fn();
const mockRecordTransactionMutate = vi.fn();

vi.mock('@/hooks/usePortfolio', () => ({
  useAddHolding: () => ({
    mutate: mockAddHoldingMutate,
    isPending: false,
  }),
  useRecordTransaction: () => ({
    mutate: mockRecordTransactionMutate,
    isPending: false,
  }),
}));

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  mode: 'add-holding' as const,
  portfolioId: 'p1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TransactionForm', () => {
  it('renders form fields for add-holding mode', () => {
    render(<TransactionForm {...defaultProps} />);

    expect(screen.getByText('Add Holding')).toBeInTheDocument();
    expect(screen.getByLabelText('Symbol')).toBeInTheDocument();
    expect(screen.getByLabelText('Base')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Date')).toBeInTheDocument();
    expect(screen.getByLabelText('Fee')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
  });

  it('shows Record Transaction title for record mode', () => {
    render(
      <TransactionForm
        {...defaultProps}
        mode="record-transaction"
        symbol="BTCUSDT"
        baseAsset="BTC"
        quoteAsset="USDT"
      />
    );

    expect(screen.getByText('Record Transaction - BTCUSDT')).toBeInTheDocument();
  });

  it('hides symbol fields in record-transaction mode', () => {
    render(
      <TransactionForm
        {...defaultProps}
        mode="record-transaction"
        symbol="BTCUSDT"
        baseAsset="BTC"
        quoteAsset="USDT"
      />
    );

    expect(screen.queryByLabelText('Symbol')).not.toBeInTheDocument();
  });

  it('defaults to buy type', () => {
    render(<TransactionForm {...defaultProps} />);

    const buyButton = screen.getByRole('button', { name: 'Buy' });
    expect(buyButton.className).toContain('bg-bullish');
  });

  it('shows validation errors for empty required fields', async () => {
    const user = userEvent.setup();
    render(<TransactionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText(/symbol is required/i)).toBeInTheDocument();
  });

  it('links error messages to inputs via aria-describedby', async () => {
    const user = userEvent.setup();
    render(<TransactionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: 'Add' }));

    const symbolInput = screen.getByLabelText('Symbol');
    expect(symbolInput).toHaveAttribute('aria-describedby', 'error-symbol');
    expect(symbolInput).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById('error-symbol')).toHaveTextContent(/symbol is required/i);
  });

  it('calls addHolding mutation in add-holding mode', async () => {
    const user = userEvent.setup();
    render(<TransactionForm {...defaultProps} />);

    await user.type(screen.getByLabelText('Symbol'), 'BTCUSDT');
    await user.type(screen.getByLabelText('Base'), 'BTC');
    await user.type(screen.getByLabelText('Quantity'), '0.5');
    await user.type(screen.getByLabelText('Price'), '40000');

    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddHoldingMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        type: 'buy',
        quantity: 0.5,
        price: 40000,
      }),
      expect.any(Object)
    );
  });

  it('calls recordTransaction mutation in record mode', async () => {
    const user = userEvent.setup();
    render(
      <TransactionForm
        {...defaultProps}
        mode="record-transaction"
        symbol="BTCUSDT"
        baseAsset="BTC"
        quoteAsset="USDT"
      />
    );

    await user.type(screen.getByLabelText('Quantity'), '0.5');
    await user.type(screen.getByLabelText('Price'), '50000');

    await user.click(screen.getByRole('button', { name: 'Record' }));

    expect(mockRecordTransactionMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'buy',
        quantity: 0.5,
        price: 50000,
      }),
      expect.any(Object)
    );
  });

  it('has cancel button that closes dialog', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<TransactionForm {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
