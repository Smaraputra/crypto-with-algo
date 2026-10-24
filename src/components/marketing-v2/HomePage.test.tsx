import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from 'next-auth/react';
import { HomePage } from './HomePage';

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: () => ({
    data: [
      {
        symbol: 'BTCUSDT',
        lastPrice: '67000',
        priceChange: '500',
        priceChangePercent: '0.75',
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
  }),
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

  it('renders the price strip and real capabilities', () => {
    render(<HomePage />);

    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'What you can do' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Research in the open' })).toBeInTheDocument();
  });

  it('renders honest lab description without counts or pass claims', () => {
    render(<HomePage />);

    expect(
      screen.getByText(
        'Every idea is tested on live data, and ideas that fail stay on the record. The price score was measured on years of history and showed no edge after costs, so it is shown as context only. Sign in to see each test and where it stands.'
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
