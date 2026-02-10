import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));

import { CTASection } from './CTASection';

describe('CTASection', () => {
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
    render(<CTASection />);
    expect(
      screen.getByRole('heading', { name: 'Start Tracking Today' })
    ).toBeInTheDocument();
  });

  it('renders CTA link to /register', () => {
    render(<CTASection />);
    const link = screen.getByRole('link', { name: /Create Free Account/i });
    expect(link).toHaveAttribute('href', '/register');
  });

  it('renders description text', () => {
    render(<CTASection />);
    expect(
      screen.getByText(/Create your free account/)
    ).toBeInTheDocument();
  });
});
