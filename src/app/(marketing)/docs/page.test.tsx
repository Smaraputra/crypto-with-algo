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

import DocsPage from './page';

describe('DocsPage', () => {
  it('renders the Documentation heading', () => {
    render(<DocsPage />);
    expect(screen.getByRole('heading', { name: 'Documentation', level: 1 })).toBeInTheDocument();
  });

  it('renders Getting Started section', () => {
    render(<DocsPage />);
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('1. Create an Account')).toBeInTheDocument();
  });

  it('renders Feature Reference section', () => {
    render(<DocsPage />);
    expect(screen.getByText('Feature Reference')).toBeInTheDocument();
    expect(screen.getByText('Portfolio Tracking')).toBeInTheDocument();
    expect(screen.getByText('Interactive Charts')).toBeInTheDocument();
  });

  it('renders nav and footer', () => {
    render(<DocsPage />);
    expect(screen.getAllByText('AlgoCrypto').length).toBeGreaterThanOrEqual(2);
  });
});
