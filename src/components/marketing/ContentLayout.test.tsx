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

import { ContentLayout } from './ContentLayout';

describe('ContentLayout', () => {
  it('renders title and subtitle', () => {
    render(
      <ContentLayout title="Test Title" subtitle="Test subtitle text">
        <p>Page content</p>
      </ContentLayout>
    );
    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test subtitle text')).toBeInTheDocument();
  });

  it('renders children', () => {
    render(
      <ContentLayout title="Title" subtitle="Sub">
        <p>Child content</p>
      </ContentLayout>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('renders LandingNav and Footer', () => {
    render(
      <ContentLayout title="Title" subtitle="Sub">
        <p>Content</p>
      </ContentLayout>
    );
    expect(screen.getAllByText('CryptoWithAlgo').length).toBeGreaterThanOrEqual(1);
  });

  it('has skip-to-content target (main#main-content)', () => {
    const { container } = render(
      <ContentLayout title="Title" subtitle="Sub">
        <p>Content</p>
      </ContentLayout>
    );
    expect(container.querySelector('main#main-content')).toBeInTheDocument();
  });
});
