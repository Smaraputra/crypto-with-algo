import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSignOut = vi.fn();
let mockSession: { data: { user: { name: string; email: string } } | null } = {
  data: null,
};

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

const mockToggleSidebar = vi.fn();
const mockSetMobileSidebarOpen = vi.fn();

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      toggleSidebar: mockToggleSidebar,
      setMobileSidebarOpen: mockSetMobileSidebarOpen,
      setSelectedSymbol: vi.fn(),
    }),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: () => ({ data: [], isLoading: false }),
}));

import { Header } from './Header';

beforeEach(() => {
  vi.clearAllMocks();
  mockSession = { data: null };
});

describe('Header', () => {
  it('renders Crypto Tracker title', () => {
    render(<Header />);
    expect(screen.getByText('Crypto Tracker')).toBeInTheDocument();
  });

  it('renders desktop toggle sidebar button', () => {
    render(<Header />);
    expect(screen.getByLabelText('Toggle sidebar')).toBeInTheDocument();
  });

  it('renders mobile open menu button', () => {
    render(<Header />);
    expect(screen.getByLabelText('Open menu')).toBeInTheDocument();
  });

  it('calls toggleSidebar on desktop button click', async () => {
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByLabelText('Toggle sidebar'));
    expect(mockToggleSidebar).toHaveBeenCalledOnce();
  });

  it('calls setMobileSidebarOpen(true) on mobile button click', async () => {
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByLabelText('Open menu'));
    expect(mockSetMobileSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('shows user dropdown when session exists', () => {
    mockSession = {
      data: { user: { name: 'Test User', email: 'test@example.com' } },
    };
    render(<Header />);
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('does not show user dropdown when no session', () => {
    render(<Header />);
    expect(screen.queryByText('Test User')).not.toBeInTheDocument();
  });

  it('renders search button for symbol search', () => {
    render(<Header />);
    expect(screen.getByLabelText('Search trading pairs')).toBeInTheDocument();
  });

  it('calls signOut with callbackUrl on sign out click', async () => {
    mockSession = {
      data: { user: { name: 'Test User', email: 'test@example.com' } },
    };
    const user = userEvent.setup();
    render(<Header />);

    // Open the dropdown
    await user.click(screen.getByText('Test User'));
    // Click sign out
    await user.click(screen.getByText('Sign out'));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });
});
