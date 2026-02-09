import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));
vi.mock('@gsap/react', async () => await import('@/__mocks__/@gsap/react'));

import { StatsSection } from './StatsSection';

describe('StatsSection', () => {
  it('renders stats grid', () => {
    render(<StatsSection />);
    expect(screen.getByTestId('stats-grid')).toBeInTheDocument();
  });

  it('renders four stat labels', () => {
    render(<StatsSection />);
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    expect(screen.getByText('Latency')).toBeInTheDocument();
    expect(screen.getByText('Active Users')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
  });

  it('renders counter elements with aria-labels', () => {
    render(<StatsSection />);
    expect(screen.getByLabelText('99.9% Uptime')).toBeInTheDocument();
    expect(screen.getByLabelText('50ms Latency')).toBeInTheDocument();
    expect(screen.getByLabelText('10K+ Active Users')).toBeInTheDocument();
    expect(screen.getByLabelText('24/7 Monitoring')).toBeInTheDocument();
  });
});
