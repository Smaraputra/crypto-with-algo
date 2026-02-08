import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateAlertForm } from './CreateAlertForm';

const mockCreateAlertMutate = vi.fn();

vi.mock('@/hooks/useAlerts', () => ({
  useCreateAlert: () => ({
    mutate: mockCreateAlertMutate,
    isPending: false,
  }),
}));

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: () => ({
    data: {
      portfolios: [
        { _id: 'p1', name: 'My Portfolio', holdingsCount: 2 },
        { _id: 'p2', name: 'Trading', holdingsCount: 1 },
      ],
    },
  }),
  usePortfolio: (id: string | null) => ({
    data: id === 'p1'
      ? {
          portfolio: {
            _id: 'p1',
            name: 'My Portfolio',
            holdings: [
              { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', quantity: 0.5, avgBuyPrice: 40000 },
              { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', quantity: 10, avgBuyPrice: 3000 },
            ],
          },
        }
      : undefined,
  }),
}));

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CreateAlertForm', () => {
  it('renders form with tabs', () => {
    render(<CreateAlertForm {...defaultProps} />);

    expect(screen.getByRole('heading', { name: 'Create Alert' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Price Alert' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Portfolio Alert' })).toBeInTheDocument();
  });

  it('renders price alert fields by default', () => {
    render(<CreateAlertForm {...defaultProps} />);

    expect(screen.getByLabelText('Symbol')).toBeInTheDocument();
    expect(screen.getByLabelText('Target Price')).toBeInTheDocument();
  });

  it('pre-fills symbol when defaultSymbol provided', () => {
    render(<CreateAlertForm {...defaultProps} defaultSymbol="BTCUSDT" />);

    expect(screen.getByLabelText('Symbol')).toHaveValue('BTCUSDT');
  });

  it('switches to percent change field', async () => {
    const user = userEvent.setup();
    render(<CreateAlertForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: '% Change' }));

    expect(screen.getByLabelText('Percent Change (%)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Target Price')).not.toBeInTheDocument();
  });

  it('switches to portfolio tab', async () => {
    const user = userEvent.setup();
    render(<CreateAlertForm {...defaultProps} />);

    await user.click(screen.getByRole('tab', { name: 'Portfolio Alert' }));

    expect(screen.getByLabelText('Portfolio')).toBeInTheDocument();
    expect(screen.getByLabelText('Threshold Value (USD)')).toBeInTheDocument();
  });

  it('shows validation errors for missing price alert fields', async () => {
    const user = userEvent.setup();
    render(<CreateAlertForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: 'Create Alert' }));

    expect(screen.getByText('Symbol is required')).toBeInTheDocument();
  });

  it('calls createAlert mutation with price_above data', async () => {
    const user = userEvent.setup();
    render(<CreateAlertForm {...defaultProps} />);

    await user.type(screen.getByLabelText('Symbol'), 'BTCUSDT');
    await user.type(screen.getByLabelText('Target Price'), '100000');

    await user.click(screen.getByRole('button', { name: 'Create Alert' }));

    expect(mockCreateAlertMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'price_above',
        symbol: 'BTCUSDT',
        targetPrice: 100000,
      }),
      expect.any(Object)
    );
  });

  it('calls createAlert with price_below data', async () => {
    const user = userEvent.setup();
    render(<CreateAlertForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: 'Below' }));
    await user.type(screen.getByLabelText('Symbol'), 'ETHUSDT');
    await user.type(screen.getByLabelText('Target Price'), '2000');

    await user.click(screen.getByRole('button', { name: 'Create Alert' }));

    expect(mockCreateAlertMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'price_below',
        symbol: 'ETHUSDT',
        targetPrice: 2000,
      }),
      expect.any(Object)
    );
  });

  it('includes recurring and cooldown when checked', async () => {
    const user = userEvent.setup();
    render(<CreateAlertForm {...defaultProps} />);

    await user.type(screen.getByLabelText('Symbol'), 'BTCUSDT');
    await user.type(screen.getByLabelText('Target Price'), '100000');
    await user.click(screen.getByLabelText('Recurring alert'));

    await user.click(screen.getByRole('button', { name: 'Create Alert' }));

    expect(mockCreateAlertMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        recurring: true,
        cooldownMinutes: 60,
      }),
      expect.any(Object)
    );
  });

  it('has cancel button that closes dialog', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<CreateAlertForm {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render form when dialog closed', () => {
    render(<CreateAlertForm open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByText('Create Alert')).not.toBeInTheDocument();
  });
});
