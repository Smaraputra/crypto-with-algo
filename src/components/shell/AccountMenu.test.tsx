import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu } from './AccountMenu';

const mockUseSession = vi.fn();
const mockSignOut = vi.fn();

vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
  signOut: (args: unknown) => mockSignOut(args),
}));

vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">ThemeToggleMock</button>,
}));

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders trigger button', () => {
    mockUseSession.mockReturnValue({ data: { user: { email: 'user@example.com', isAdmin: false } } });
    render(<AccountMenu />);
    expect(screen.getByRole('button', { name: /account/i })).toBeInTheDocument();
  });

  it('hides admin links when isAdmin is false', () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });
    render(<AccountMenu />);
    const trigger = screen.getByRole('button', { name: /account/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    expect(screen.queryByRole('menuitem', { name: 'Admin calibration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Admin paper desk' })).not.toBeInTheDocument();
  });

  it('shows admin links when isAdmin is true', () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'admin@example.com', isAdmin: true } },
    });
    render(<AccountMenu />);
    const trigger = screen.getByRole('button', { name: /account/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    const adminCalib = screen.getByRole('menuitem', { name: 'Admin calibration' });
    const adminDesk = screen.getByRole('menuitem', { name: 'Admin paper desk' });

    expect(adminCalib).toBeInTheDocument();
    expect(adminCalib).toHaveAttribute('href', '/admin/calibration');
    expect(adminDesk).toBeInTheDocument();
    expect(adminDesk).toHaveAttribute('href', '/admin/paper-desk');
  });

  it('shows user email and common links', () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });
    render(<AccountMenu />);
    const trigger = screen.getByRole('button', { name: /account/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('menuitem', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  });

  it('Log out calls signOut with { callbackUrl: "/login" }', () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'user@example.com', isAdmin: false } },
    });
    render(<AccountMenu />);
    const trigger = screen.getByRole('button', { name: /account/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    const logout = screen.getByRole('menuitem', { name: 'Log out' });
    fireEvent.click(logout);

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });
});
