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
    expect(screen.getByText('CryptoWithAlgo')).toBeInTheDocument();
  });

  it('renders tagline', () => {
    render(<Footer />);
    expect(screen.getByText('Built for traders, by traders.')).toBeInTheDocument();
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

  it('renders GitHub social link with correct href', () => {
    render(<Footer />);
    const githubLink = screen.getByLabelText('GitHub');
    expect(githubLink).toBeInTheDocument();
    expect(githubLink).toHaveAttribute('href', 'https://github.com/Smaraputra/crypto-with-algo');
  });

  it('renders legal links', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
  });

  it('renders copyright text', () => {
    render(<Footer />);
    const year = new Date().getFullYear().toString();
    expect(screen.getByText(new RegExp(year))).toBeInTheDocument();
  });

  it('renders product link columns', () => {
    render(<Footer />);
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('Resources')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders product links', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Portfolio' })).toHaveAttribute('href', '/portfolio');
    expect(screen.getByRole('link', { name: 'Alerts' })).toHaveAttribute('href', '/alerts');
    expect(screen.getByRole('link', { name: 'Signals' })).toHaveAttribute('href', '/signals');
  });

  it('renders resource links with correct hrefs', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: 'Features' })).toHaveAttribute('href', '/features');
    expect(screen.getByRole('link', { name: 'How It Works' })).toHaveAttribute('href', '/how-it-works');
  });
});
