import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IndicatorSettings } from './IndicatorSettings';

// Radix Popover needs pointer events
class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IndicatorSettings', () => {
  const defaultProps = {
    indicatorId: 'MA',
    indicatorName: 'Moving Average',
    calcParams: [5, 10, 30, 60],
    onParamsChange: vi.fn(),
  };

  it('renders settings button with correct aria-label', () => {
    render(<IndicatorSettings {...defaultProps} />);
    expect(screen.getByLabelText('Settings for Moving Average')).toBeInTheDocument();
  });

  it('opens popover when settings button is clicked', async () => {
    render(<IndicatorSettings {...defaultProps} />);

    const trigger = screen.getByLabelText('Settings for Moving Average');
    fireEvent.click(trigger);

    expect(await screen.findByText('Moving Average')).toBeInTheDocument();
    expect(screen.getByText('Period 1')).toBeInTheDocument();
    expect(screen.getByText('Period 2')).toBeInTheDocument();
  });

  it('displays current param values in inputs', async () => {
    render(<IndicatorSettings {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Settings for Moving Average'));

    const inputs = await screen.findAllByRole('spinbutton');
    expect(inputs[0]).toHaveValue(5);
    expect(inputs[1]).toHaveValue(10);
    expect(inputs[2]).toHaveValue(30);
    expect(inputs[3]).toHaveValue(60);
  });

  it('calls onParamsChange when input value changes', () => {
    render(<IndicatorSettings {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Settings for Moving Average'));

    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '20' } });

    expect(defaultProps.onParamsChange).toHaveBeenCalledWith('MA', [20, 10, 30, 60]);
  });

  it('calls onParamsChange with defaults on reset', async () => {
    render(<IndicatorSettings {...defaultProps} calcParams={[20, 20, 50, 100]} />);

    fireEvent.click(screen.getByLabelText('Settings for Moving Average'));

    const resetButton = await screen.findByLabelText('Reset Moving Average parameters');
    fireEvent.click(resetButton);

    expect(defaultProps.onParamsChange).toHaveBeenCalledWith('MA', [5, 10, 30, 60]);
  });

  it('returns null for indicator with no params', () => {
    const { container } = render(
      <IndicatorSettings
        indicatorId="UNKNOWN"
        indicatorName="Unknown"
        calcParams={[]}
        onParamsChange={vi.fn()}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('clamps input values to min/max range', () => {
    render(<IndicatorSettings {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Settings for Moving Average'));

    const inputs = screen.getAllByRole('spinbutton');
    // Directly fire change event with value above max
    fireEvent.change(inputs[0], { target: { value: '999' } });

    // MA Period 1 max is 200, should clamp to 200
    expect(defaultProps.onParamsChange).toHaveBeenCalledWith('MA', [200, 10, 30, 60]);
  });
});
