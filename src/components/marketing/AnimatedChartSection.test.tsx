import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('framer-motion', async () => await import('@/__mocks__/framer-motion'));

import { AnimatedChartSection } from './AnimatedChartSection';

describe('AnimatedChartSection', () => {
  it('renders section heading', () => {
    render(<AnimatedChartSection />);
    expect(
      screen.getByRole('heading', { name: 'Real-Time Market Intelligence' })
    ).toBeInTheDocument();
  });

  it('renders description text', () => {
    render(<AnimatedChartSection />);
    expect(
      screen.getByText(/Track price movements/)
    ).toBeInTheDocument();
  });

  it('renders chart container', () => {
    render(<AnimatedChartSection />);
    expect(screen.getByTestId('animated-chart')).toBeInTheDocument();
  });

  it('renders accessible SVG chart', () => {
    render(<AnimatedChartSection />);
    expect(
      screen.getByRole('img', { name: /Animated price chart/ })
    ).toBeInTheDocument();
  });
});
