import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardError from './error';

describe('DashboardError', () => {
  const defaultProps = {
    error: Object.assign(new Error('Test error'), { digest: 'abc123' }),
    reset: vi.fn(),
  };

  it('renders error message and description', () => {
    render(<DashboardError {...defaultProps} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(
      screen.getByText('An unexpected error occurred. Please try again.')
    ).toBeInTheDocument();
  });

  it('renders Try Again button', () => {
    render(<DashboardError {...defaultProps} />);

    expect(
      screen.getByRole('button', { name: /try again/i })
    ).toBeInTheDocument();
  });

  it('calls reset on button click', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();

    render(<DashboardError {...{ ...defaultProps, reset }} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(reset).toHaveBeenCalledOnce();
  });
});
