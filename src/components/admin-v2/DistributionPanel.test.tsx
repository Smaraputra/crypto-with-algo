import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { DistributionPanel, formatDistributionTick } from './DistributionPanel';
import type { DistributionResponse } from '@/types/calibration';

vi.mock('@/lib/chart-theme', () => ({
  useChartTheme: () => ({
    grid: '#E2E5E9',
    crosshair: '#7C8490',
    up: '#067346',
    down: '#C21F36',
    volume: '#E4E7EB',
    text: '#0F1114',
    mutedText: '#59606B',
    line: '#E2E5E9',
    accentLine: '#067346',
  }),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithSizedContainer } = await import('@/test/recharts');
  return rechartsWithSizedContainer(await importOriginal<Record<string, unknown>>());
});

const mockDistribution: DistributionResponse = {
  binEdges: [-2, -1, 0, 1, 2],
  bins: [
    {
      low: -2,
      high: -1,
      counts: { strong_buy: 2, buy: 5, sell: 12 },
    },
    {
      low: -1,
      high: 0,
      counts: { strong_buy: 10, buy: 20, sell: 15 },
    },
    {
      low: 0,
      high: 1,
      counts: { strong_buy: 25, buy: 30, sell: 8 },
    },
    {
      low: 1,
      high: 2,
      counts: { strong_buy: 15, buy: 8, sell: 3 },
    },
  ],
  tiers: ['strong_buy', 'buy', 'sell'],
  clipped: { strong_buy: 2, buy: 1 },
};

describe('DistributionPanel', () => {
  it('renders histogram container and clipped count footnote', () => {
    render(<DistributionPanel data={mockDistribution} />);

    expect(screen.getByTestId('distribution-chart')).toBeInTheDocument();
    expect(screen.getByText(/3 outcomes clipped outside bin range/)).toBeInTheDocument();
  });

  it('choosing one tier changes the plotted totals', () => {
    const { container } = render(<DistributionPanel data={mockDistribution} />);

    const select = screen.getByLabelText('Tier');
    expect(select).toBeInTheDocument();

    const rectsBefore = Array.from(
      container.querySelectorAll('.recharts-rectangle')
    ).map((el) => el.getAttribute('d'));

    fireEvent.change(select, { target: { value: 'buy' } });

    const rectsAfter = Array.from(
      container.querySelectorAll('.recharts-rectangle')
    ).map((el) => el.getAttribute('d'));

    expect(rectsBefore).not.toEqual(rectsAfter);
    // When 'buy' is selected, clipped count shows 1
    expect(screen.getByText(/1 outcomes clipped outside bin range/)).toBeInTheDocument();
  });

  it('tick formatter turns -0.4 into "-0.4%"', () => {
    expect(formatDistributionTick(-0.4)).toBe('-0.4%');
    expect(formatDistributionTick(0.2)).toBe('+0.2%');
    expect(formatDistributionTick(0)).toBe('0.0%');
  });

  it('no element uses #E57373', () => {
    const { container } = render(<DistributionPanel data={mockDistribution} />);
    expect(container.innerHTML).not.toContain('#E57373');
  });

  it('renders empty notice when bins are empty', () => {
    const emptyDist: DistributionResponse = {
      binEdges: [],
      bins: [],
      tiers: [],
      clipped: {},
    };
    render(<DistributionPanel data={emptyDist} />);

    expect(
      screen.getByText('No return distribution data available.')
    ).toBeInTheDocument();
  });
});
