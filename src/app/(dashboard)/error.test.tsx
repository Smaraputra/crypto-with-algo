import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardError from './error';

describe('DashboardError', () => {
  const defaultProps = {
    error: Object.assign(new Error('Test error'), { digest: 'abc123' }),
    reset: vi.fn(),
  };

  it('renders error notice with title and description', () => {
    render(<DashboardError {...defaultProps} />);

    expect(screen.getByText('This page did not load.')).toBeInTheDocument();
    expect(
      screen.getByText('Something went wrong on our side. Try again, or go back to the market.')
    ).toBeInTheDocument();
  });

  it('renders Try again button and Back to market link', () => {
    render(<DashboardError {...defaultProps} />);

    expect(
      screen.getByRole('button', { name: 'Try again' })
    ).toBeInTheDocument();

    const backLink = screen.getByRole('link', { name: 'Back to market' });
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute('href', '/dashboard');
  });

  it('calls reset on Try again button click', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();

    render(<DashboardError {...{ ...defaultProps, reset }} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(reset).toHaveBeenCalledOnce();
  });
});
