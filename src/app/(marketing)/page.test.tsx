import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarketingHomePage, { metadata } from './page';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated', update: vi.fn() }),
}));

vi.mock('@/components/marketing-v2/hero/HeroGlobe', () => ({
  HeroGlobe: () => <div data-testid="hero-globe">Globe</div>,
}));

vi.mock('@/components/marketing-v2/LiveTicker', () => ({
  LiveTicker: () => (
    <ul aria-label="Live prices">
      <li>
        <span>BTC</span>
        <span>$67,000.00</span>
      </li>
    </ul>
  ),
}));

vi.mock('@/components/marketing-v2/LiveCandles', () => ({
  LiveCandles: () => (
    <div data-testid="live-candles">
      <svg role="img" aria-label="BTC hourly candles, last 48 hours, last price $67,000.00" />
    </div>
  ),
}));

describe('MarketingHomePage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe(
      'Crypto market tracker with an open research lab | CryptoWithAlgo'
    );
    expect(metadata.description).toBeDefined();
  });

  it('renders HomePage with h1 headline, actions, evidence section and caption', () => {
    render(<MarketingHomePage />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'A crypto market tracker with an open research lab',
      })
    ).toBeInTheDocument();

    expect(screen.getAllByRole('link', { name: 'Create a free account' })[0]).toHaveAttribute(
      'href',
      '/register'
    );

    expect(
      screen.getByRole('heading', { level: 2, name: 'How evidence builds' })
    ).toBeInTheDocument();

    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<MarketingHomePage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
    expect(container.textContent).not.toMatch(
      /public record|public research lab|public ledger|markdown|survivorship|instant|currently validated|volume delta|frozen/i
    );
  });
});
