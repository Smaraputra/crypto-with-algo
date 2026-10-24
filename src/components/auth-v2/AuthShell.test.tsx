import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthShell } from './AuthShell';

describe('AuthShell', () => {
  it('renders the product home link, back to home link and h1 heading', () => {
    render(
      <AuthShell title="Sign in" description="Welcome back">
        <div data-testid="form-child">Form Content</div>
      </AuthShell>
    );

    const brandLink = screen.getByRole('link', { name: 'CryptoWithAlgo' });
    expect(brandLink).toBeInTheDocument();
    expect(brandLink).toHaveAttribute('href', '/');

    const backLink = screen.getByRole('link', { name: 'Back to home' });
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute('href', '/');
    expect(backLink).toHaveClass('min-h-[44px]');

    const main = screen.getByRole('main');
    expect(main).toBeInTheDocument();
    expect(main).toHaveAttribute('id', 'main-content');

    const heading = screen.getByRole('heading', { level: 1, name: 'Sign in' });
    expect(heading).toBeInTheDocument();

    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByTestId('form-child')).toBeInTheDocument();
  });

  it('renders without description when omitted', () => {
    render(
      <AuthShell title="Create account">
        <div>Content</div>
      </AuthShell>
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Create account' })).toBeInTheDocument();
  });
});
