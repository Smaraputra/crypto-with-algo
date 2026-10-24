import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
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

describe('AppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders top bar, phone top strip and bottom navigation', () => {
    render(<AppShell />);

    // Brand links (desktop and phone strip)
    const brandLinks = screen.getAllByRole('link', { name: /CryptoWithAlgo/ });
    expect(brandLinks.length).toBeGreaterThanOrEqual(2);

    // Desktop nav items
    expect(screen.getByRole('navigation', { name: 'Desktop primary' })).toBeInTheDocument();

    // Phone bottom nav
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });
});
