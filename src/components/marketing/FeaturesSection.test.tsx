import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('framer-motion', async () => await import('@/__mocks__/framer-motion'));

import { FeaturesSection } from './FeaturesSection';

describe('FeaturesSection', () => {
  it('renders section heading', () => {
    render(<FeaturesSection />);
    expect(
      screen.getByRole('heading', { name: 'Everything You Need' })
    ).toBeInTheDocument();
  });

  it('renders 6 feature cards', () => {
    render(<FeaturesSection />);
    const grid = screen.getByTestId('features-grid');
    const cards = grid.querySelectorAll('[data-slot="card"]');
    expect(cards).toHaveLength(6);
  });

  it('renders all feature titles', () => {
    render(<FeaturesSection />);
    expect(screen.getByText('Portfolio Management')).toBeInTheDocument();
    expect(screen.getByText('Live Market Data')).toBeInTheDocument();
    expect(screen.getByText('Smart Alerts')).toBeInTheDocument();
    expect(screen.getByText('Analytics Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Interactive Charts')).toBeInTheDocument();
    expect(screen.getByText('Tax Export')).toBeInTheDocument();
  });
});
