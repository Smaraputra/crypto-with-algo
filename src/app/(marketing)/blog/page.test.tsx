import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null }),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import BlogPage from './page';

describe('BlogPage', () => {
  it('renders the Blog heading', () => {
    render(<BlogPage />);
    expect(screen.getByRole('heading', { name: 'Blog', level: 1 })).toBeInTheDocument();
  });

  it('renders article cards', () => {
    render(<BlogPage />);
    expect(
      screen.getByText('Understanding Technical Indicators for Crypto Trading')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Building a Diversified Crypto Portfolio')
    ).toBeInTheDocument();
  });

  it('renders article categories', () => {
    render(<BlogPage />);
    expect(screen.getByText('Education')).toBeInTheDocument();
    expect(screen.getByText('Strategy')).toBeInTheDocument();
    expect(screen.getByText('Tutorial')).toBeInTheDocument();
    // "Product" appears both as category badge and footer column heading
    expect(screen.getAllByText('Product').length).toBeGreaterThanOrEqual(2);
  });

  it('renders read time', () => {
    render(<BlogPage />);
    expect(screen.getByText('8 min read')).toBeInTheDocument();
  });

  it('renders formatted dates', () => {
    render(<BlogPage />);
    expect(screen.getByText('January 15, 2025')).toBeInTheDocument();
  });
});
