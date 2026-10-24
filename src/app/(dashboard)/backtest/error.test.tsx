import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BacktestError from './error';

describe('BacktestError', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders its title and does not render the secret error message', () => {
    const secretMessage = 'secret detail';
    const error = Object.assign(new Error(secretMessage), { digest: 'd-backtest-1' });

    render(<BacktestError error={error} reset={vi.fn()} />);

    expect(screen.getByText('Backtest did not load.')).toBeInTheDocument();
    expect(screen.queryByText(secretMessage)).not.toBeInTheDocument();
  });

  it('logs the error with console.error', () => {
    const error = Object.assign(new Error('backtest crash'), { digest: 'd-backtest-1' });

    render(<BacktestError error={error} reset={vi.fn()} />);

    expect(consoleErrorSpy).toHaveBeenCalledWith(error);
  });

  it('calls reset when Try again is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    const error = Object.assign(new Error('backtest error'), { digest: 'd-backtest-1' });

    render(<BacktestError error={error} reset={reset} />);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
