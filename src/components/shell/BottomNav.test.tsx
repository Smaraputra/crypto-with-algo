import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomNav } from './BottomNav';

const mockUsePathname = vi.fn();
const mockUseSession = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
  signOut: vi.fn(),
}));

vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">MockThemeToggle</button>,
}));

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue('/dashboard');
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });
  });

  it('renders five items: Market, Lab, Portfolio, Journal, More', () => {
    render(<BottomNav />);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Market' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Lab' })).toHaveAttribute('href', '/lab');
    expect(screen.getByRole('link', { name: 'Portfolio' })).toHaveAttribute('href', '/portfolio');
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute('href', '/journal');
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('sets aria-current on active item according to pathname', () => {
    mockUsePathname.mockReturnValue('/dashboard');
    const { rerender } = render(<BottomNav />);
    expect(screen.getByRole('link', { name: 'Market' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Lab' })).not.toHaveAttribute('aria-current');

    mockUsePathname.mockReturnValue('/lab');
    rerender(<BottomNav />);
    expect(screen.getByRole('link', { name: 'Lab' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Market' })).not.toHaveAttribute('aria-current');
  });

  it('clicking More opens the sheet listing its items, with Notes linking to /research', () => {
    render(<BottomNav />);

    const moreButton = screen.getByRole('button', { name: 'More' });
    fireEvent.click(moreButton);

    expect(screen.getByRole('heading', { name: 'More' })).toBeInTheDocument();

    const notesLink = screen.getByRole('link', { name: 'Notes' });
    expect(notesLink).toBeInTheDocument();
    expect(notesLink).toHaveAttribute('href', '/research');

    expect(screen.getByRole('link', { name: 'Alerts' })).toHaveAttribute('href', '/alerts');
    expect(screen.getByRole('link', { name: 'Cost Check' })).toHaveAttribute('href', '/cost-check');
    expect(screen.getByRole('link', { name: 'Backtest' })).toHaveAttribute('href', '/backtest');
    expect(screen.getByRole('link', { name: 'Signals' })).toHaveAttribute('href', '/signals');
  });
});
