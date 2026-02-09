import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/marketing/SmoothScroll', () => ({
  SmoothScroll: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

import MarketingLayout from './layout';

describe('MarketingLayout', () => {
  it('renders skip-to-content link', () => {
    render(
      <MarketingLayout>
        <main id="main-content">Content</main>
      </MarketingLayout>
    );
    const skipLink = screen.getByText('Skip to content');
    expect(skipLink).toBeInTheDocument();
    expect(skipLink).toHaveAttribute('href', '#main-content');
  });

  it('skip-to-content link has sr-only class', () => {
    render(
      <MarketingLayout>
        <div>Content</div>
      </MarketingLayout>
    );
    const skipLink = screen.getByText('Skip to content');
    expect(skipLink.className).toContain('sr-only');
  });

  it('renders children', () => {
    render(
      <MarketingLayout>
        <div data-testid="child">Hello</div>
      </MarketingLayout>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});
