import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockSession: { data: { user: { name: string; email: string } } | null } = {
  data: null,
};

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: () => void;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LandingNav } from './LandingNav';

describe('LandingNav', () => {
  beforeEach(() => {
    mockSession = { data: null };
  });

  it('renders branding text', () => {
    render(<LandingNav />);
    expect(screen.getByText('AlgoCrypto')).toBeInTheDocument();
  });

  it('renders Sign In link pointing to /login when unauthenticated', () => {
    render(<LandingNav />);
    const links = screen.getAllByText('Sign In');
    const desktopLink = links.find((el) => el.closest('a'));
    expect(desktopLink?.closest('a')).toHaveAttribute('href', '/login');
  });

  it('renders Get Started link pointing to /register when unauthenticated', () => {
    render(<LandingNav />);
    const links = screen.getAllByText('Get Started');
    const desktopLink = links.find((el) => el.closest('a'));
    expect(desktopLink?.closest('a')).toHaveAttribute('href', '/register');
  });

  it('renders center nav links (Features, How It Works, Docs, Blog)', () => {
    render(<LandingNav />);
    expect(screen.getAllByText('Features').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('How It Works').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Docs').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Blog').length).toBeGreaterThanOrEqual(1);
  });

  it('renders Docs link pointing to /docs', () => {
    render(<LandingNav />);
    const docsLinks = screen.getAllByText('Docs');
    const desktopLink = docsLinks.find((el) => el.closest('a'));
    expect(desktopLink?.closest('a')).toHaveAttribute('href', '/docs');
  });

  it('renders Features link pointing to /features', () => {
    render(<LandingNav />);
    const links = screen.getAllByText('Features');
    const desktopLink = links.find((el) => el.closest('a'));
    expect(desktopLink?.closest('a')).toHaveAttribute('href', '/features');
  });

  it('renders How It Works link pointing to /how-it-works', () => {
    render(<LandingNav />);
    const links = screen.getAllByText('How It Works');
    const desktopLink = links.find((el) => el.closest('a'));
    expect(desktopLink?.closest('a')).toHaveAttribute('href', '/how-it-works');
  });

  it('toggles mobile menu on hamburger click', async () => {
    const user = userEvent.setup();
    render(<LandingNav />);

    const toggle = screen.getByLabelText('Toggle menu');
    await user.click(toggle);

    // Mobile menu should be visible with both links
    const mobileSignIn = screen.getAllByText('Sign In');
    expect(mobileSignIn.length).toBeGreaterThanOrEqual(2);
  });

  it('hamburger button has aria-expanded attribute', async () => {
    const user = userEvent.setup();
    render(<LandingNav />);

    const toggle = screen.getByLabelText('Toggle menu');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('mobile menu has role="menu"', async () => {
    const user = userEvent.setup();
    render(<LandingNav />);

    await user.click(screen.getByLabelText('Toggle menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes mobile menu on Escape key', async () => {
    const user = userEvent.setup();
    render(<LandingNav />);

    await user.click(screen.getByLabelText('Toggle menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  describe('when authenticated', () => {
    beforeEach(() => {
      mockSession = {
        data: { user: { name: 'Test User', email: 'test@example.com' } },
      };
    });

    it('shows Dashboard link instead of Sign In / Get Started (desktop)', () => {
      render(<LandingNav />);
      const dashboardLink = screen.getByText('Dashboard');
      expect(dashboardLink.closest('a')).toHaveAttribute('href', '/dashboard');
      expect(screen.queryByText('Sign In')).not.toBeInTheDocument();
      expect(screen.queryByText('Get Started')).not.toBeInTheDocument();
    });

    it('shows Dashboard link in mobile menu', async () => {
      const user = userEvent.setup();
      render(<LandingNav />);

      await user.click(screen.getByLabelText('Toggle menu'));
      const dashboardLinks = screen.getAllByText('Dashboard');
      expect(dashboardLinks.length).toBeGreaterThanOrEqual(2); // desktop + mobile
      expect(screen.queryByText('Sign In')).not.toBeInTheDocument();
      expect(screen.queryByText('Get Started')).not.toBeInTheDocument();
    });
  });
});
