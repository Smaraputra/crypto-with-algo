import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));
vi.mock('@gsap/react', async () => await import('@/__mocks__/@gsap/react'));
vi.mock('./HeroBackground', () => ({
  HeroBackground: () => <div data-testid="hero-background" />,
}));
vi.mock('./GlobeScene', () => ({
  default: () => <div data-testid="globe-scene" />,
}));

import { HeroSection } from './HeroSection';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });

  // Mock IntersectionObserver for CountUp component
  global.IntersectionObserver = class MockIntersectionObserver {
    callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe() {
      this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    get root() { return null; }
    get rootMargin() { return ''; }
    get thresholds() { return []; }
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});

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
      screen.getByText(/Track cryptocurrency portfolios with live Binance data/)
    ).toBeInTheDocument();
  });

  it('ticker has aria-label and role="status"', () => {
    render(<HeroSection />);
    const ticker = screen.getByTestId('hero-ticker');
    expect(ticker).toHaveAttribute('role', 'status');
    expect(ticker).toHaveAttribute('aria-label', 'Live cryptocurrency prices');
    expect(ticker).toHaveAttribute('aria-live', 'polite');
  });

  it('renders stats grid with 3 stats', () => {
    render(<HeroSection />);
    const statsGrid = screen.getByTestId('stats-grid');
    expect(statsGrid).toBeInTheDocument();
    const articles = statsGrid.querySelectorAll('article');
    expect(articles).toHaveLength(3);
  });
});
