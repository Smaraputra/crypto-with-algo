import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from 'next-auth/react';
import { MarketingNav } from './MarketingNav';

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

describe('MarketingNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn(),
    });
  });

  it('renders desktop navigation links and account actions when unauthenticated', () => {
    render(<MarketingNav />);

    expect(screen.getByRole('link', { name: /CryptoWithAlgo/ })).toHaveAttribute('href', '/');
    expect(screen.getAllByRole('link', { name: 'Features' })[0]).toHaveAttribute('href', '/features');
    expect(screen.getAllByRole('link', { name: 'Features' })[0]).toHaveClass('min-h-[44px]');
    expect(screen.getAllByRole('link', { name: 'How it works' })[0]).toHaveAttribute('href', '/how-it-works');
    expect(screen.getAllByRole('link', { name: 'Docs' })[0]).toHaveAttribute('href', '/docs');
    expect(screen.getAllByRole('link', { name: 'Blog' })[0]).toHaveAttribute('href', '/blog');
    expect(screen.getAllByRole('link', { name: 'Log in' })[0]).toHaveAttribute('href', '/login');
    expect(screen.getAllByRole('link', { name: 'Create a free account' })[0]).toHaveAttribute('href', '/register');
    expect(screen.queryByRole('link', { name: 'Open dashboard' })).not.toBeInTheDocument();
  });

  it('shows Open dashboard and hides Log in and Create account when authenticated', () => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: 'u1', name: 'Alice', tosAccepted: true, isAdmin: false }, expires: '1' },
      status: 'authenticated',
      update: vi.fn(),
    });

    render(<MarketingNav />);

    const dashboardLink = screen.getByRole('link', { name: 'Open dashboard' });
    expect(dashboardLink).toBeInTheDocument();
    expect(dashboardLink).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create a free account' })).not.toBeInTheDocument();
  });

  it('holds the signed-out actions invisible while the session loads, so nothing flashes', () => {
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'loading',
      update: vi.fn(),
    });

    render(<MarketingNav />);

    // The space is kept (no layout shift), but the links are hidden and out of the tab order.
    const login = screen.getByText('Log in');
    const group = login.closest('div');
    expect(group).toHaveClass('invisible');
    expect(group).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open dashboard' })).not.toBeInTheDocument();
  });

  it('opens and closes phone menu when unauthenticated', () => {
    render(<MarketingNav />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle menu' });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();

    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.length).toBe(6);
    expect(menuItems[0]).toHaveTextContent('Features');
    expect(menuItems[1]).toHaveTextContent('How it works');
    expect(menuItems[2]).toHaveTextContent('Docs');
    expect(menuItems[3]).toHaveTextContent('Blog');
    expect(menuItems[4]).toHaveTextContent('Log in');
    expect(menuItems[5]).toHaveTextContent('Create a free account');

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(toggleButton).toHaveFocus();
  });

  it('phone menu shows Open dashboard as the last item when authenticated', () => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: 'u1', name: 'Alice', tosAccepted: true, isAdmin: false }, expires: '1' },
      status: 'authenticated',
      update: vi.fn(),
    });

    render(<MarketingNav />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle menu' });
    fireEvent.click(toggleButton);

    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.length).toBe(5);
    expect(menuItems[0]).toHaveTextContent('Features');
    expect(menuItems[1]).toHaveTextContent('How it works');
    expect(menuItems[2]).toHaveTextContent('Docs');
    expect(menuItems[3]).toHaveTextContent('Blog');
    expect(menuItems[4]).toHaveTextContent('Open dashboard');
    expect(menuItems[4]).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByRole('menuitem', { name: 'Log in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Create a free account' })).not.toBeInTheDocument();
  });

  it('closes phone menu on Escape key press and returns focus', () => {
    render(<MarketingNav />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle menu' });
    fireEvent.click(toggleButton);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(toggleButton).toHaveFocus();
  });

  it('closes phone menu when a link inside it is clicked and returns focus', () => {
    render(<MarketingNav />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle menu' });
    fireEvent.click(toggleButton);

    const menuItems = screen.getAllByRole('menuitem');
    fireEvent.click(menuItems[0]);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(toggleButton).toHaveFocus();
  });
});
