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
  // These tests used to assert four hardcoded fake articles -- invented titles,
  // invented 2025 dates, invented read times -- which is what kept the
  // fabricated content in place. The page is now honest about having no posts,
  // and these assert that instead.
  it('renders the Blog heading', () => {
    render(<BlogPage />);
    expect(screen.getByRole('heading', { name: 'Blog', level: 1 })).toBeInTheDocument();
  });

  it('says there are no posts yet', () => {
    render(<BlogPage />);
    expect(screen.getByRole('heading', { name: 'No posts yet' })).toBeInTheDocument();
  });

  it('points at the documentation instead', () => {
    render(<BlogPage />);
    const link = screen.getByRole('link', { name: 'documentation' });
    expect(link).toHaveAttribute('href', '/docs');
  });

  it('presents no article metadata, fabricated or otherwise', () => {
    render(<BlogPage />);
    // No read times, no article dates: the tells of the placeholder content.
    expect(screen.queryByText(/min read/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d{4}$/)).not.toBeInTheDocument();
  });
});
