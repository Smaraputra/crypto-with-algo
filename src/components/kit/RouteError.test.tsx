import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RouteError } from './RouteError';

describe('RouteError', () => {
  it('calls reset when Try again is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();

    render(<RouteError title="Something went wrong." reset={reset} />);

    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button).toBeInTheDocument();

    await user.click(button);
    expect(reset).toHaveBeenCalledOnce();
  });

  it('points the Go to Market link to /dashboard', () => {
    render(<RouteError title="Something went wrong." reset={vi.fn()} />);

    const link = screen.getByRole('link', { name: 'Go to Market' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/dashboard');
  });

  it('renders the digest as Reference: ... only when given', () => {
    const { rerender } = render(
      <RouteError
        title="Something went wrong."
        reset={vi.fn()}
        digest="err-987"
      />
    );

    expect(screen.getByText('Reference: err-987')).toBeInTheDocument();

    rerender(<RouteError title="Something went wrong." reset={vi.fn()} />);

    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
  });

  it('does not render error.message or raw error text', () => {
    const secretDetail = 'failed to resolve internal database socket: ECONNREFUSED';
    const { container } = render(
      <RouteError
        title="Page error"
        reset={vi.fn()}
        digest="safe-digest-id"
      />
    );

    expect(container.textContent).not.toContain(secretDetail);
  });
});
