import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BacktestConfigPanel } from './BacktestConfigPanel';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';

describe('BacktestConfigPanel', () => {
  const defaultProps = {
    config: { ...DEFAULT_BACKTEST_CONFIG },
    onChange: vi.fn(),
  };

  it('renders config panel', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByTestId('backtest-config-panel')).toBeInTheDocument();
  });

  it('renders Configuration title', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('renders entry threshold input', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByLabelText('Entry Threshold (long)')).toHaveValue(30);
  });

  it('renders exit threshold input', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByLabelText('Exit Threshold (long)')).toHaveValue(-10);
  });

  it('renders stop loss input as percentage', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    const input = screen.getByLabelText('Stop Loss %');
    expect(input).toHaveValue(5);
  });

  it('renders take profit input as percentage', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    const input = screen.getByLabelText('Take Profit %');
    expect(input).toHaveValue(10);
  });

  it('renders starting capital input', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByLabelText('Starting Capital')).toHaveValue(10000);
  });

  it('calls onChange when entry threshold changes', () => {
    const onChange = vi.fn();
    render(<BacktestConfigPanel {...defaultProps} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Entry Threshold (long)'), {
      target: { value: '40' },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ entryThreshold: 40 })
    );
  });

  it('renders allow shorts checkbox', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByLabelText('Allow Short Trades')).toBeInTheDocument();
  });

  it('calls onChange when checkbox toggled', () => {
    const onChange = vi.fn();
    render(<BacktestConfigPanel {...defaultProps} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Allow Short Trades'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ allowShorts: true })
    );
  });
});
