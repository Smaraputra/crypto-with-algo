import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import HowItWorksPage from './page';

describe('HowItWorksPage', () => {
  it('renders heading', () => {
    render(<HowItWorksPage />);
    expect(
      screen.getByRole('heading', { name: 'How It Works', level: 1 })
    ).toBeInTheDocument();
  });

  it('renders subtitle', () => {
    render(<HowItWorksPage />);
    expect(
      screen.getByText(/three simple steps/)
    ).toBeInTheDocument();
  });

  it('renders all three steps', () => {
    render(<HowItWorksPage />);
    expect(screen.getByText('Step 1')).toBeInTheDocument();
    expect(screen.getByText('Step 2')).toBeInTheDocument();
    expect(screen.getByText('Step 3')).toBeInTheDocument();
  });

  it('renders step titles', () => {
    render(<HowItWorksPage />);
    expect(
      screen.getByRole('heading', { name: 'Sign Up' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Track' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Analyze' })
    ).toBeInTheDocument();
  });

  it('renders step detail cards', () => {
    render(<HowItWorksPage />);
    expect(
      screen.getByText('Register with email - no credit card required')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Create portfolios and add crypto holdings')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Real-time WebSocket price monitoring 24/7')
    ).toBeInTheDocument();
  });

  it('renders CTA link to register', () => {
    render(<HowItWorksPage />);
    const link = screen.getByRole('link', { name: /Create Free Account/i });
    expect(link).toHaveAttribute('href', '/register');
  });
});
