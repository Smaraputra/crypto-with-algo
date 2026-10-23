import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavLink } from './NavLink';

const mockUsePathname = vi.fn();
const mockUseLinkStatus = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock('next/link', async () => {
  const actual = await vi.importActual<typeof import('next/link')>('next/link');
  return {
    ...actual,
    useLinkStatus: () => mockUseLinkStatus(),
  };
});

describe('NavLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue('/dashboard');
    mockUseLinkStatus.mockReturnValue({ pending: false });
  });

  it('renders link with text and correct href', () => {
    render(<NavLink href="/dashboard">Market</NavLink>);
    const link = screen.getByRole('link', { name: /market/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/dashboard');
  });

  it('sets aria-current="page" when active', () => {
    mockUsePathname.mockReturnValue('/dashboard');
    render(<NavLink item={{ label: 'Market', href: '/dashboard', matchPaths: ['/dashboard'] }} />);
    const link = screen.getByRole('link', { name: /market/i });
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('does not set aria-current when idle', () => {
    mockUsePathname.mockReturnValue('/lab');
    render(<NavLink item={{ label: 'Market', href: '/dashboard', matchPaths: ['/dashboard'] }} />);
    const link = screen.getByRole('link', { name: /market/i });
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('data-pending follows mocked useLinkStatus', () => {
    // When pending is false
    mockUseLinkStatus.mockReturnValue({ pending: false });
    const { rerender } = render(<NavLink href="/lab">Lab</NavLink>);
    const indicatorFalse = screen.getByTestId('nav-pending-indicator');
    expect(indicatorFalse).not.toHaveAttribute('data-pending');

    // When pending is true
    mockUseLinkStatus.mockReturnValue({ pending: true });
    rerender(<NavLink href="/lab">Lab</NavLink>);
    const indicatorTrue = screen.getByTestId('nav-pending-indicator');
    expect(indicatorTrue).toHaveAttribute('data-pending');
  });
});
