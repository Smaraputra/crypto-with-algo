import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StrategyForm } from './StrategyForm';
import { mockStrategy } from '@/__fixtures__/strategies';

// Radix Dialog needs ResizeObserver
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
  unobserve() {}
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StrategyForm', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSubmit: vi.fn(),
    isPending: false,
  };

  it('renders new strategy title when no initial', () => {
    render(<StrategyForm {...defaultProps} />);
    expect(screen.getByText('New Strategy')).toBeInTheDocument();
  });

  it('renders edit strategy title when initial provided', () => {
    render(<StrategyForm {...defaultProps} initial={mockStrategy} />);
    expect(screen.getByText('Edit Strategy')).toBeInTheDocument();
  });

  it('pre-fills name when editing', () => {
    render(<StrategyForm {...defaultProps} initial={mockStrategy} />);
    const input = screen.getByLabelText('Name');
    expect(input).toHaveValue('BTC Momentum');
  });

  it('shows all symbol buttons', () => {
    render(<StrategyForm {...defaultProps} />);
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
  });

  it('shows all interval buttons', () => {
    render(<StrategyForm {...defaultProps} />);
    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('4h')).toBeInTheDocument();
    expect(screen.getByText('1d')).toBeInTheDocument();
  });

  it('shows weight total as 100% with defaults', () => {
    render(<StrategyForm {...defaultProps} />);
    expect(screen.getByText('Total: 100%')).toBeInTheDocument();
  });

  it('disables submit when name is empty', () => {
    render(<StrategyForm {...defaultProps} />);
    const submitBtn = screen.getByTestId('strategy-submit');
    expect(submitBtn).toBeDisabled();
  });

  it('disables submit when isPending', () => {
    render(<StrategyForm {...defaultProps} isPending={true} initial={mockStrategy} />);
    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('shows Create Strategy button for new form', () => {
    render(<StrategyForm {...defaultProps} />);
    expect(screen.getByText('Create Strategy')).toBeInTheDocument();
  });

  it('shows Update Strategy button for edit form', () => {
    render(<StrategyForm {...defaultProps} initial={mockStrategy} />);
    expect(screen.getByText('Update Strategy')).toBeInTheDocument();
  });

  it('calls onSubmit with form data when valid', () => {
    const onSubmit = vi.fn();
    render(<StrategyForm {...defaultProps} onSubmit={onSubmit} initial={mockStrategy} />);

    fireEvent.click(screen.getByTestId('strategy-submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'BTC Momentum',
        symbols: ['BTCUSDT'],
        intervals: ['1h', '4h'],
      })
    );
  });
});
