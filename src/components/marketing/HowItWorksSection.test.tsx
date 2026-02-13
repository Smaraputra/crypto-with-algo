import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));

import { HowItWorksSection } from './HowItWorksSection';

describe('HowItWorksSection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    global.IntersectionObserver = class IntersectionObserver {
      constructor() {}
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof globalThis.IntersectionObserver;
  });

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
    expect(screen.getByText('Register')).toBeInTheDocument();
    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Track')).toBeInTheDocument();
  });

  it('renders step descriptions', () => {
    render(<HowItWorksSection />);
    expect(screen.getByText(/Create a free account/)).toBeInTheDocument();
    expect(screen.getByText(/Set up watchlist/)).toBeInTheDocument();
    expect(screen.getByText(/Monitor live market data/)).toBeInTheDocument();
  });
});
