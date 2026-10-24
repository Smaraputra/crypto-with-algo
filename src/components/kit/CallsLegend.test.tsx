import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CallsLegend } from './CallsLegend';

describe('CallsLegend', () => {
  const baseProps = {
    show: true,
    onShowChange: vi.fn(),
    eligible: true,
    ineligibleReason: null as 'symbol' | 'interval' | null,
    tally: null,
    error: false,
    hoverText: null,
  };

  it('the switch has role="switch", aria-checked="true" when shown, and clicking it calls onShowChange(false)', async () => {
    const user = userEvent.setup();
    const onShowChange = vi.fn();

    render(<CallsLegend {...baseProps} onShowChange={onShowChange} />);

    const toggle = screen.getByRole('switch', { name: 'Show calls' });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    expect(onShowChange).toHaveBeenCalledTimes(1);
    expect(onShowChange).toHaveBeenCalledWith(false);
  });

  it('the four key texts render when shown', () => {
    render(<CallsLegend {...baseProps} />);

    expect(screen.getByText('Buy call under the bar, sell call over it.')).toBeInTheDocument();
    expect(screen.getByText('Won after costs')).toBeInTheDocument();
    expect(screen.getByText('Right, costs ate it')).toBeInTheDocument();
    expect(screen.getByText('Wrong way')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('"Calls are hidden." when show is false', () => {
    render(<CallsLegend {...baseProps} show={false} />);

    expect(screen.getByText('Calls are hidden.')).toBeInTheDocument();
    expect(screen.queryByText('Won after costs')).not.toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Show calls' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('each ineligible reason renders its line and no switch', () => {
    const { rerender } = render(
      <CallsLegend {...baseProps} eligible={false} ineligibleReason="symbol" />
    );

    expect(
      screen.getByText('Calls are recorded for the ten signal coins only.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Show calls' })).not.toBeInTheDocument();

    rerender(<CallsLegend {...baseProps} eligible={false} ineligibleReason="interval" />);

    expect(screen.getByText('Calls are not recorded at this interval.')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Show calls' })).not.toBeInTheDocument();
  });

  it('renders tally line text for { calls: 3, right: 2, won: 1, cost: 1, wrong: 1, pending: 0 }', () => {
    render(
      <CallsLegend
        {...baseProps}
        tally={{ calls: 3, right: 2, won: 1, cost: 1, wrong: 1, pending: 0 }}
      />
    );

    expect(
      screen.getByText(
        'In view: 3 calls, 1 won after costs, 1 eaten by costs, 1 wrong way, 0 pending.'
      )
    ).toBeInTheDocument();
  });

  it('uses "1 call" for a single call in tally', () => {
    render(
      <CallsLegend
        {...baseProps}
        tally={{ calls: 1, right: 1, won: 1, cost: 0, wrong: 0, pending: 0 }}
      />
    );

    expect(
      screen.getByText(
        'In view: 1 call, 1 won after costs, 0 eaten by costs, 0 wrong way, 0 pending.'
      )
    ).toBeInTheDocument();
  });

  it('"No calls in view." for zero', () => {
    render(
      <CallsLegend
        {...baseProps}
        tally={{ calls: 0, right: 0, won: 0, cost: 0, wrong: 0, pending: 0 }}
      />
    );

    expect(screen.getByText('No calls in view.')).toBeInTheDocument();
  });

  it('hoverText wins over the tally', () => {
    const hoverText = 'Buy call (Strong buy), live record, score 32.0: outcome pending';
    render(
      <CallsLegend
        {...baseProps}
        hoverText={hoverText}
        tally={{ calls: 3, right: 2, won: 1, cost: 1, wrong: 1, pending: 0 }}
      />
    );

    expect(screen.getByText(hoverText)).toBeInTheDocument();
    expect(screen.queryByText(/In view:/)).not.toBeInTheDocument();
  });

  it('renders the error line', () => {
    render(
      <CallsLegend
        {...baseProps}
        error={true}
        tally={{ calls: 3, right: 2, won: 1, cost: 1, wrong: 1, pending: 0 }}
      />
    );

    expect(screen.getByText('Past calls did not load.')).toBeInTheDocument();
    expect(screen.queryByText(/In view:/)).not.toBeInTheDocument();
  });
});
