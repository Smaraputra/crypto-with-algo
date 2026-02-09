import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SignalsError from './error';

describe('SignalsError', () => {
  const defaultProps = {
    error: Object.assign(new Error('Test error'), { digest: 'abc123' }),
    reset: vi.fn(),
  };

  it('renders error message', () => {
    render(<SignalsError {...defaultProps} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('calls reset on Try Again click', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();

    render(<SignalsError {...{ ...defaultProps, reset }} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(reset).toHaveBeenCalledOnce();
  });
});
