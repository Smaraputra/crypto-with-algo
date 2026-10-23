import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteLoading } from './RouteLoading';

describe('RouteLoading', () => {
  it('renders a polite status region with accessible name Loading', () => {
    const { container } = render(<RouteLoading />);
    const status = screen.getByRole('status', { name: 'Loading' });
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Loading')).toHaveClass('sr-only');
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('renders static grey blocks sized like PageHeader and Panel', () => {
    const { container } = render(<RouteLoading className="custom-class" />);
    const status = screen.getByRole('status', { name: 'Loading' });
    expect(status).toHaveClass('custom-class');
    const greyBlocks = container.querySelectorAll('.bg-muted');
    expect(greyBlocks.length).toBeGreaterThanOrEqual(3);
  });
});
