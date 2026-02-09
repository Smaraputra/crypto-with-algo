import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));
vi.mock('@gsap/react', async () => await import('@/__mocks__/@gsap/react'));

import { HowItWorksSection } from './HowItWorksSection';

describe('HowItWorksSection', () => {
  it('renders section heading', () => {
    render(<HowItWorksSection />);
    expect(
      screen.getByRole('heading', { name: 'How It Works' })
    ).toBeInTheDocument();
  });

  it('renders three steps', () => {
    render(<HowItWorksSection />);
    const grid = screen.getByTestId('how-it-works-grid');
    const cards = grid.querySelectorAll('[data-step-card]');
    expect(cards).toHaveLength(3);
  });

  it('renders step titles', () => {
    render(<HowItWorksSection />);
    expect(screen.getByText('Connect')).toBeInTheDocument();
    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Automate')).toBeInTheDocument();
  });

  it('renders step descriptions', () => {
    render(<HowItWorksSection />);
    expect(screen.getByText(/Link your exchange API keys/)).toBeInTheDocument();
    expect(screen.getByText(/Set risk parameters/)).toBeInTheDocument();
    expect(screen.getByText(/analyze markets/)).toBeInTheDocument();
  });
});
