import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));
vi.mock('@gsap/react', async () => await import('@/__mocks__/@gsap/react'));
vi.mock('./HeroBackground', () => ({
  HeroBackground: () => <div data-testid="hero-background" />,
}));
vi.mock('./GlobeScene', () => ({
  default: () => <div data-testid="globe-scene" />,
}));

import { HeroSection } from './HeroSection';

const mockPricesResponse = [
  { symbol: 'BTCUSDT', lastPrice: '67432.18', priceChangePercent: '2.34' },
  { symbol: 'ETHUSDT', lastPrice: '3521.45', priceChangePercent: '-0.87' },
  { symbol: 'SOLUSDT', lastPrice: '142.67', priceChangePercent: '5.12' },
  { symbol: 'BNBUSDT', lastPrice: '612.33', priceChangePercent: '1.45' },
];

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HeroSection', () => {
  it('renders main heading', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockPricesResponse)));
    render(<HeroSection />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders Get Started Free CTA linking to /register', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockPricesResponse)));
    render(<HeroSection />);
    const link = screen.getByRole('link', { name: /Get Started Free/i });
    expect(link).toHaveAttribute('href', '/register');
  });

  it('renders Sign In CTA linking to /login', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockPricesResponse)));
    render(<HeroSection />);
    const link = screen.getByRole('link', { name: /Sign In/i });
    expect(link).toHaveAttribute('href', '/login');
  });

  it('renders ticker with mock data initially', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify([])));
    render(<HeroSection />);
    expect(screen.getByTestId('hero-ticker')).toBeInTheDocument();
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('SOL')).toBeInTheDocument();
  });

  it('updates ticker with real prices from API', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockPricesResponse))
    );

    render(<HeroSection />);

    await waitFor(() => {
      expect(screen.getByText('$67,432.18')).toBeInTheDocument();
    });
    expect(screen.getByText('$3,521.45')).toBeInTheDocument();
    expect(screen.getByText('$142.67')).toBeInTheDocument();
    expect(screen.getByText('$612.33')).toBeInTheDocument();
  });

  it('keeps mock data on fetch error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    render(<HeroSection />);

    // Wait a tick to ensure the effect ran
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // Mock data should still be showing
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('$67,432.18')).toBeInTheDocument();
  });

  it('keeps mock data on non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Forbidden', { status: 403 }));

    render(<HeroSection />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('$67,432.18')).toBeInTheDocument();
  });

  it('renders value proposition text', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockPricesResponse)));
    render(<HeroSection />);
    expect(
      screen.getByText(/Track cryptocurrency portfolios with live Binance data/)
    ).toBeInTheDocument();
  });

  it('ticker has aria-label and role="status"', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockPricesResponse)));
    render(<HeroSection />);
    const ticker = screen.getByTestId('hero-ticker');
    expect(ticker).toHaveAttribute('role', 'status');
    expect(ticker).toHaveAttribute('aria-label', 'Live cryptocurrency prices');
    expect(ticker).toHaveAttribute('aria-live', 'polite');
  });

  it('renders stats grid with 3 stats', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockPricesResponse)));
    render(<HeroSection />);
    const statsGrid = screen.getByTestId('stats-grid');
    expect(statsGrid).toBeInTheDocument();
    const articles = statsGrid.querySelectorAll('article');
    expect(articles).toHaveLength(3);
  });

  it('fetches from /api/prices on mount', () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockPricesResponse))
    );

    render(<HeroSection />);

    expect(fetchSpy).toHaveBeenCalledWith('/api/prices');
  });
});
