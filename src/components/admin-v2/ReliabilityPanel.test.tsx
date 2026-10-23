import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ReliabilityPanel } from './ReliabilityPanel';
import type { ReliabilityPoint } from '@/types/calibration';

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

describe('ReliabilityPanel', () => {
  it('renders points without bounds with no error bar and legend displaying "No interval" without "With interval"', () => {
    const pointsWithoutBounds: ReliabilityPoint[] = [
      {
        scoreLow: 10,
        scoreHigh: 20,
        scoreMid: 15,
        count: 25,
        meanPercent: 0.5,
        ciLowPercent: null,
        ciHighPercent: null,
        withheld: 'none',
      },
    ];

    const { container } = render(<ReliabilityPanel data={pointsWithoutBounds} />);

    // Legend says "No interval" and does NOT have "With interval"
    const legend = screen.getByTestId('reliability-legend');
    expect(legend).toHaveTextContent('No interval');
    expect(legend).not.toHaveTextContent('With interval');

    // No error bar in DOM
    const errorBars = container.querySelectorAll('.recharts-errorBar');
    expect(errorBars.length).toBe(0);

    // Reference line label "Buy cutoff" is present
    expect(screen.getByText('Buy cutoff')).toBeInTheDocument();

    // Reading aid is present
    expect(
      screen.getByText(
        'A score that carries information slopes up through zero. A sign error slopes down.'
      )
    ).toBeInTheDocument();

    // Axis labels are present
    expect(screen.getByText('Price score (signed)')).toBeInTheDocument();
    expect(screen.getByText('Mean return, before costs')).toBeInTheDocument();
  });

  it('renders error bar when points have confidence bounds and legend has no "No interval" entry', () => {
    const pointsWithBounds: ReliabilityPoint[] = [
      {
        scoreLow: 25,
        scoreHigh: 35,
        scoreMid: 30,
        count: 100,
        meanPercent: 1.2,
        ciLowPercent: 0.4,
        ciHighPercent: 2.0,
        withheld: 'none',
      },
    ];

    const { container } = render(<ReliabilityPanel data={pointsWithBounds} />);

    // Scatter with interval should have an error bar
    const errorBars = container.querySelectorAll('.recharts-errorBar');
    expect(errorBars.length).toBeGreaterThan(0);

    // Legend has "With interval" and does NOT have "No interval"
    const legend = screen.getByTestId('reliability-legend');
    expect(legend).toHaveTextContent('With interval');
    expect(legend).not.toHaveTextContent('No interval');
  });

  it('does not plot points with null mean', () => {
    const pointsWithNullMean: ReliabilityPoint[] = [
      {
        scoreLow: 0,
        scoreHigh: 10,
        scoreMid: 5,
        count: 10,
        meanPercent: null,
        ciLowPercent: null,
        ciHighPercent: null,
        withheld: 'too-few-samples',
      },
    ];

    const { container } = render(<ReliabilityPanel data={pointsWithNullMean} />);
    // No scatter symbols rendered
    const symbols = container.querySelectorAll('.recharts-scatter-symbol');
    expect(symbols.length).toBe(0);
  });
});
