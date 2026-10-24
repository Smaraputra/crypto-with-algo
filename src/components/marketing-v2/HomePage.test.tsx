import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from 'next-auth/react';
import { HomePage } from './HomePage';

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

vi.mock('./hero/HeroGlobe', () => ({
  HeroGlobe: () => <div data-testid="hero-globe">Globe</div>,
}));

vi.mock('./LiveTicker', () => ({
  LiveTicker: () => (
    <ul aria-label="Live prices">
      <li>
        <span>BTC</span>
        <span>$67,000.00</span>
      </li>
    </ul>
  ),
}));

vi.mock('./LiveCandles', () => ({
  LiveCandles: () => (
    <div data-testid="live-candles">
      <svg role="img" aria-label="BTC hourly candles, last 48 hours, last price $67,000.00" />
    </div>
  ),
}));

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn(),
    });
  });

  it('renders honest headline, subline, and actions', () => {
    render(<HomePage />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('A crypto market tracker with an open research lab');

    expect(
      screen.getByText(
        'Track live crypto prices, study a coin with its trading costs, and follow an open record of trading ideas tested on live data.'
      )
    ).toBeInTheDocument();

    const createLinks = screen.getAllByRole('link', { name: 'Create a free account' });
    expect(createLinks.length).toBeGreaterThan(0);
    expect(createLinks[0]).toHaveAttribute('href', '/register');

    expect(screen.getByRole('link', { name: 'See how it works' })).toHaveAttribute(
      'href',
      '/how-it-works'
    );
  });

  it('the signed-in hero shows Open dashboard', () => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: 'u1', name: 'Alice', tosAccepted: true, isAdmin: false }, expires: '1' },
      status: 'authenticated',
      update: vi.fn(),
    });

    render(<HomePage />);

    const dashboardLinks = screen.getAllByRole('link', { name: 'Open dashboard' });
    expect(dashboardLinks.length).toBe(2);
    expect(dashboardLinks[0]).toHaveAttribute('href', '/dashboard');
    expect(dashboardLinks[1]).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByRole('link', { name: 'Create a free account' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See how it works' })).toBeInTheDocument();
  });

  it('renders live prices in hero, candles, real capabilities, and evidence tape', () => {
    render(<HomePage />);

    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByTestId('hero-globe')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'What you can do' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Live BTC and ETH, hour by hour' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'How evidence builds' })
    ).toBeInTheDocument();
    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Prices that move' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Research in the open' })
    ).not.toBeInTheDocument();
  });

  it('renders honest lab description in evidence tape', () => {
    render(<HomePage />);

    expect(
      screen.getByText(
        'Each idea in the lab bets a small, fixed stake on live bars, after trading costs. Wins add evidence and losses take it away.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'An idea counts as validated only when its evidence crosses a line set before its test began. Ideas that fail stay on the lab record.'
      )
    ).toBeInTheDocument();
  });

  it('does not contain any element with the uppercase class', () => {
    const { container } = render(<HomePage />);
    expect(container.querySelectorAll('.uppercase')).toHaveLength(0);
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<HomePage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
    expect(container.textContent).not.toMatch(
      /public record|public research lab|public ledger|markdown|survivorship|instant|currently validated|volume delta|frozen/i
    );
  });
});
