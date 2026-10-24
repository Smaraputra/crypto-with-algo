import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const mockUsePathname = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { email: 'user@example.com', isAdmin: false } } }),
  signOut: vi.fn(),
}));

vi.mock('@/hooks/useAlerts', () => ({
  useAlerts: () => ({ data: { alerts: [] }, isLoading: false, isError: false }),
  useUnreadAlertCount: () => 0,
  useAcknowledgeAlert: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: () => ({ data: [], isLoading: false, isError: false }),
}));

vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => ({ symbols: [], addSymbol: vi.fn(), removeSymbol: vi.fn() }),
}));

vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">MockThemeToggle</button>,
}));

describe('TopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue('/dashboard');
  });

  it('renders the five links with the right hrefs plus Tools, Search and Account buttons', () => {
    render(<TopBar />);

    expect(screen.getByRole('link', { name: /CryptoWithAlgo/ })).toHaveAttribute(
      'href',
      '/dashboard'
    );

    const market = screen.getByRole('link', { name: 'Market' });
    expect(market).toHaveAttribute('href', '/dashboard');

    const lab = screen.getByRole('link', { name: 'Lab' });
    expect(lab).toHaveAttribute('href', '/lab');

    const portfolio = screen.getByRole('link', { name: 'Portfolio' });
    expect(portfolio).toHaveAttribute('href', '/portfolio');

    const journal = screen.getByRole('link', { name: 'Journal' });
    expect(journal).toHaveAttribute('href', '/journal');

    const alerts = screen.getByRole('link', { name: 'Alerts' });
    expect(alerts).toHaveAttribute('href', '/alerts');

    expect(screen.getByRole('button', { name: /tools/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search coins/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /account/i })).toBeInTheDocument();
  });

  it('sets aria-current on the active link according to usePathname', () => {
    mockUsePathname.mockReturnValue('/dashboard');
    const { rerender } = render(<TopBar />);
    expect(screen.getByRole('link', { name: 'Market' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Lab' })).not.toHaveAttribute('aria-current');

    mockUsePathname.mockReturnValue('/lab');
    rerender(<TopBar />);
    expect(screen.getByRole('link', { name: 'Lab' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Market' })).not.toHaveAttribute('aria-current');

    mockUsePathname.mockReturnValue('/portfolio');
    rerender(<TopBar />);
    expect(screen.getByRole('link', { name: 'Portfolio' })).toHaveAttribute('aria-current', 'page');

    mockUsePathname.mockReturnValue('/journal');
    rerender(<TopBar />);
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');

    mockUsePathname.mockReturnValue('/alerts');
    rerender(<TopBar />);
    expect(screen.getByRole('link', { name: 'Alerts' })).toHaveAttribute('aria-current', 'page');
  });
});
