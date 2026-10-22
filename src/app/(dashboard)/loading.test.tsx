import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DashboardLoading from './loading';

describe('DashboardLoading', () => {
  it('renders a polite status region labelled Loading', () => {
    render(<DashboardLoading />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Loading');
  });

  it('renders three hidden skeleton blocks', () => {
    const { container } = render(<DashboardLoading />);
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons).toHaveLength(3);
    skeletons.forEach((skeleton) => {
      expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
