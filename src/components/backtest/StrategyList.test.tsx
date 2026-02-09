import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StrategyList } from './StrategyList';
import { mockStrategies, mockStrategy } from '@/__fixtures__/strategies';

describe('StrategyList', () => {
  const defaultProps = {
    strategies: mockStrategies,
    isLoading: false,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    deletingId: null,
  };

  it('renders strategy names', () => {
    render(<StrategyList {...defaultProps} />);
    expect(screen.getByText('BTC Momentum')).toBeInTheDocument();
    expect(screen.getByText('ETH Trend')).toBeInTheDocument();
    expect(screen.getByText('Inactive Strategy')).toBeInTheDocument();
  });

  it('shows strategy count', () => {
    render(<StrategyList {...defaultProps} />);
    expect(screen.getByText('3 / 5 strategies')).toBeInTheDocument();
  });

  it('shows Active/Inactive badges', () => {
    render(<StrategyList {...defaultProps} />);
    const activeBadges = screen.getAllByText('Active');
    expect(activeBadges).toHaveLength(2);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('calls onEdit when edit button clicked', () => {
    const onEdit = vi.fn();
    render(<StrategyList {...defaultProps} onEdit={onEdit} />);
    fireEvent.click(screen.getByLabelText('Edit BTC Momentum'));
    expect(onEdit).toHaveBeenCalledWith(mockStrategy);
  });

  it('calls onDelete when delete button clicked', () => {
    const onDelete = vi.fn();
    render(<StrategyList {...defaultProps} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText('Delete BTC Momentum'));
    expect(onDelete).toHaveBeenCalledWith('strat-1');
  });

  it('disables delete button when deleting', () => {
    render(<StrategyList {...defaultProps} deletingId="strat-1" />);
    expect(screen.getByLabelText('Delete BTC Momentum')).toBeDisabled();
  });

  it('shows loading skeletons', () => {
    render(<StrategyList {...defaultProps} isLoading={true} strategies={[]} />);
    expect(screen.getByTestId('strategy-list-loading')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    render(<StrategyList {...defaultProps} strategies={[]} />);
    expect(screen.getByTestId('strategy-list-empty')).toBeInTheDocument();
  });
});
