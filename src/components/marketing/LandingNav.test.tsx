import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  it('renders branding text', () => {
    render(<LandingNav />);
    expect(screen.getByText('AlgoCrypto')).toBeInTheDocument();
  });

  it('renders Sign In link pointing to /login', () => {
    render(<LandingNav />);
    const links = screen.getAllByText('Sign In');
    const desktopLink = links.find((el) => el.closest('a'));
    expect(desktopLink?.closest('a')).toHaveAttribute('href', '/login');
  });

  it('renders Get Started link pointing to /register', () => {
    render(<LandingNav />);
    const links = screen.getAllByText('Get Started');
    const desktopLink = links.find((el) => el.closest('a'));
    expect(desktopLink?.closest('a')).toHaveAttribute('href', '/register');
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
});
