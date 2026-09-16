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

  // Group headings
  it('renders group headings', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByTestId('group-signal-thresholds')).toHaveTextContent('Signal Thresholds');
    expect(screen.getByTestId('group-risk-management')).toHaveTextContent('Risk Management');
    expect(screen.getByTestId('group-capital')).toHaveTextContent('Capital');
  });

  // Presets
  it('renders preset buttons', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByTestId('config-presets')).toBeInTheDocument();
    expect(screen.getByText('Conservative')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
  });

  it('applies conservative preset on click', () => {
    const onChange = vi.fn();
    render(<BacktestConfigPanel {...defaultProps} onChange={onChange} />);

    fireEvent.click(screen.getByText('Conservative'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        stopLossPercent: 0.03,
        positionSizePercent: 0.05,
        entryThreshold: 32,
        allowShorts: false,
      })
    );
  });

  it('applies aggressive preset with shorts enabled', () => {
    const onChange = vi.fn();
    render(<BacktestConfigPanel {...defaultProps} onChange={onChange} />);

    fireEvent.click(screen.getByText('Aggressive'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        stopLossPercent: 0.08,
        positionSizePercent: 0.20,
        allowShorts: true,
        shortEntryThreshold: -16,
        shortExitThreshold: 12,
      })
    );
  });

  // Conditional short thresholds
  it('does not show short thresholds when allowShorts is false', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.queryByTestId('short-entry-threshold')).not.toBeInTheDocument();
    expect(screen.queryByTestId('short-exit-threshold')).not.toBeInTheDocument();
  });

  it('shows short thresholds when allowShorts is true', () => {
    render(
      <BacktestConfigPanel
        {...defaultProps}
        config={{ ...DEFAULT_BACKTEST_CONFIG, allowShorts: true }}
      />
    );
    expect(screen.getByTestId('short-entry-threshold')).toBeInTheDocument();
    expect(screen.getByTestId('short-exit-threshold')).toBeInTheDocument();
    expect(screen.getByLabelText('Entry Threshold (short)')).toHaveValue(-30);
    expect(screen.getByLabelText('Exit Threshold (short)')).toHaveValue(10);
  });

  it('renders all five session toggles active by default', () => {
    render(<BacktestConfigPanel {...defaultProps} />);
    expect(screen.getByTestId('session-toggles')).toBeInTheDocument();
    for (const session of ['asia', 'london', 'ny_overlap', 'new_york', 'off_hours']) {
      expect(screen.getByTestId(`session-toggle-${session}`)).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    }
  });

  it('deselecting a session sets allowedSessions to the remaining four', () => {
    const onChange = vi.fn();
    render(<BacktestConfigPanel config={{ ...DEFAULT_BACKTEST_CONFIG }} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('session-toggle-off_hours'));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedSessions: expect.arrayContaining(['asia', 'london', 'ny_overlap', 'new_york']),
      })
    );
    const passed = onChange.mock.calls[0][0].allowedSessions;
    expect(passed).toHaveLength(4);
    expect(passed).not.toContain('off_hours');
  });

  it('re-selecting the last missing session clears the filter', () => {
    const onChange = vi.fn();
    render(
      <BacktestConfigPanel
        config={{
          ...DEFAULT_BACKTEST_CONFIG,
          allowedSessions: ['asia', 'london', 'ny_overlap', 'new_york'],
        }}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByTestId('session-toggle-off_hours'));

    expect(onChange.mock.calls[0][0].allowedSessions).toBeUndefined();
  });
});
