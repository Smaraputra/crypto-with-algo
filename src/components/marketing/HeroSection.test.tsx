import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));
vi.mock('@gsap/react', async () => await import('@/__mocks__/@gsap/react'));
vi.mock('./HeroBackground', () => ({
  HeroBackground: () => <div data-testid="hero-background" />,
}));

import { HeroSection } from './HeroSection';

describe('HeroSection', () => {
  it('renders main heading', () => {
    render(<HeroSection />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders Get Started Free CTA linking to /register', () => {
    render(<HeroSection />);
    const link = screen.getByRole('link', { name: /Get Started Free/i });
    expect(link).toHaveAttribute('href', '/register');
  });

  it('renders Sign In CTA linking to /login', () => {
    render(<HeroSection />);
    const link = screen.getByRole('link', { name: /Sign In/i });
    expect(link).toHaveAttribute('href', '/login');
  });

  it('renders animated ticker with mock symbols', () => {
    render(<HeroSection />);
    expect(screen.getByTestId('hero-ticker')).toBeInTheDocument();
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('SOL')).toBeInTheDocument();
  });

  it('renders value proposition text', () => {
    render(<HeroSection />);
    expect(
      screen.getByText(/Live market data from Binance/)
    ).toBeInTheDocument();
  });

  it('ticker has aria-label and role="status"', () => {
    render(<HeroSection />);
    const ticker = screen.getByTestId('hero-ticker');
    expect(ticker).toHaveAttribute('role', 'status');
    expect(ticker).toHaveAttribute('aria-label', 'Live cryptocurrency prices');
    expect(ticker).toHaveAttribute('aria-live', 'polite');
  });
});
