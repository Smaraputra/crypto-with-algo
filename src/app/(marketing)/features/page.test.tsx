import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import FeaturesPage from './page';

describe('FeaturesPage', () => {
  it('renders heading', () => {
    render(<FeaturesPage />);
    expect(
      screen.getByRole('heading', { name: 'Features', level: 1 })
    ).toBeInTheDocument();
  });

  it('renders subtitle', () => {
    render(<FeaturesPage />);
    expect(
      screen.getByText(/Professional-grade tools/)
    ).toBeInTheDocument();
  });

  it('renders platform highlights', () => {
    render(<FeaturesPage />);
    expect(screen.getByText('WebSocket Architecture')).toBeInTheDocument();
    expect(screen.getByText('Secure Authentication')).toBeInTheDocument();
    expect(screen.getByText('Manual Portfolio Entry')).toBeInTheDocument();
    expect(screen.getByText('Automated Alerts')).toBeInTheDocument();
  });

  it('renders core features section', () => {
    render(<FeaturesPage />);
    expect(
      screen.getByRole('heading', { name: 'Core Features' })
    ).toBeInTheDocument();
  });

  it('renders all 7 feature cards', () => {
    render(<FeaturesPage />);
    expect(screen.getByText('Portfolio Management')).toBeInTheDocument();
    expect(screen.getByText('Live Market Data')).toBeInTheDocument();
    expect(screen.getByText('Interactive Charts')).toBeInTheDocument();
    expect(screen.getByText('Smart Alerts')).toBeInTheDocument();
    expect(screen.getByText('Analytics Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Trading Signals')).toBeInTheDocument();
    expect(screen.getByText('Backtesting Engine')).toBeInTheDocument();
  });

  it('renders feature highlights as bullet points', () => {
    render(<FeaturesPage />);
    expect(
      screen.getByText('Multiple portfolios with custom names')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Sub-second WebSocket price updates')
    ).toBeInTheDocument();
  });
});
