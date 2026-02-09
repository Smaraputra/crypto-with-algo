import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { Footer } from './Footer';

describe('Footer', () => {
  it('renders branding text', () => {
    render(<Footer />);
    expect(screen.getByText('Crypto Portfolio Tracker')).toBeInTheDocument();
  });

  it('renders Sign In link to /login', () => {
    render(<Footer />);
    const link = screen.getByRole('link', { name: 'Sign In' });
    expect(link).toHaveAttribute('href', '/login');
  });

  it('renders Register link to /register', () => {
    render(<Footer />);
    const link = screen.getByRole('link', { name: 'Register' });
    expect(link).toHaveAttribute('href', '/register');
  });

  it('renders copyright text', () => {
    render(<Footer />);
    const year = new Date().getFullYear().toString();
    expect(screen.getByText(new RegExp(year))).toBeInTheDocument();
  });
});
