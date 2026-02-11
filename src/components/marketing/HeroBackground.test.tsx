import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

import { HeroBackground } from './HeroBackground';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });

  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    scale: vi.fn(),
    fillStyle: '',
  });
});

describe('HeroBackground', () => {
  it('renders with aria-hidden', () => {
    const { container } = render(<HeroBackground />);
    const bg = container.firstElementChild;
    expect(bg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders gradient orbs', () => {
    const { container } = render(<HeroBackground />);
    const orbs = container.querySelectorAll('[data-orb]');
    expect(orbs.length).toBeGreaterThanOrEqual(2);
  });

  it('renders canvas for particles', () => {
    const { container } = render(<HeroBackground />);
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('renders perspective grid', () => {
    const { container } = render(<HeroBackground />);
    expect(container.querySelector('.hero-grid')).toBeInTheDocument();
  });
});
