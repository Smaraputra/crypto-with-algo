import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MoreSheet } from './MoreSheet';

const mockUseSession = vi.fn();
const mockSignOut = vi.fn();

vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
  signOut: (args: unknown) => mockSignOut(args),
}));

vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">MockThemeToggle</button>,
}));

describe('MoreSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders More title and its main navigation items including Notes linking to /research', () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });

    render(<MoreSheet open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'More' })).toBeInTheDocument();

    const alerts = screen.getByRole('link', { name: 'Alerts' });
    expect(alerts).toHaveAttribute('href', '/alerts');

    const costCheck = screen.getByRole('link', { name: 'Cost Check' });
    expect(costCheck).toHaveAttribute('href', '/cost-check');

    const backtest = screen.getByRole('link', { name: 'Backtest' });
    expect(backtest).toHaveAttribute('href', '/backtest');

    const notes = screen.getByRole('link', { name: 'Notes' });
    expect(notes).toHaveAttribute('href', '/research');

    const signals = screen.getByRole('link', { name: 'Signals' });
    expect(signals).toHaveAttribute('href', '/signals');

    const analytics = screen.getByRole('link', { name: 'Analytics' });
    expect(analytics).toHaveAttribute('href', '/analytics');

    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  });

  it('shows admin links only when isAdmin is true', () => {
    // When isAdmin is false
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });
    const { rerender } = render(<MoreSheet open={true} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole('link', { name: 'Admin calibration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin paper desk' })).not.toBeInTheDocument();

    // When isAdmin is true
    mockUseSession.mockReturnValue({
      data: { user: { email: 'admin@example.com', isAdmin: true } },
    });
    rerender(<MoreSheet open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Admin calibration' })).toHaveAttribute(
      'href',
      '/admin/calibration'
    );
    expect(screen.getByRole('link', { name: 'Admin paper desk' })).toHaveAttribute(
      'href',
      '/admin/paper-desk'
    );
  });

  it('Log out calls signOut with { callbackUrl: "/login" } and closes sheet', () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });
    const onOpenChange = vi.fn();
    render(<MoreSheet open={true} onOpenChange={onOpenChange} />);

    const logoutBtn = screen.getByRole('button', { name: 'Log out' });
    fireEvent.click(logoutBtn);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });

  it('the "More" navigation contains the links but not the Log out button', () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });
    render(<MoreSheet open={true} onOpenChange={vi.fn()} />);

    const nav = screen.getByRole('navigation', { name: 'More' });
    expect(nav).toBeInTheDocument();

    const links = within(nav).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    expect(within(nav).getByRole('link', { name: 'Alerts' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Privacy' })).toBeInTheDocument();

    expect(within(nav).queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });
});
