import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { CumulativePanel } from './CumulativePanel';
import type { CumulativeSeriesRow } from '@/types/calibration';

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

const mockCumulative: CumulativeSeriesRow[] = [
  {
    configVersion: 4,
    count: 10,
    points: [
      { candleTimestamp: 1728000000000, cumulativePercent: 1.5, count: 5 },
      { candleTimestamp: 1728086400000, cumulativePercent: 2.1, count: 5 },
    ],
  },
  {
    configVersion: 5,
    count: 8,
    points: [
      { candleTimestamp: 1728000000000, cumulativePercent: -0.5, count: 4 },
      { candleTimestamp: 1728086400000, cumulativePercent: 0.8, count: 4 },
    ],
  },
  {
    configVersion: 6,
    count: 0,
    points: [],
  },
];

describe('CumulativePanel', () => {
  it('renders line chart for series with points and skips empty series listing them in muted line', () => {
    render(<CumulativePanel data={mockCumulative} />);

    expect(screen.getByTestId('cumulative-chart')).toBeInTheDocument();
    // Series with no points are listed in a muted line
    expect(screen.getByText('No outcomes yet: v6')).toBeInTheDocument();
  });

  it('handles multiple empty series in the muted line', () => {
    const allEmpty: CumulativeSeriesRow[] = [
      { configVersion: 4, count: 0, points: [] },
      { configVersion: 5, count: 0, points: [] },
    ];

    render(<CumulativePanel data={allEmpty} />);

    expect(
      screen.getByText('No cumulative return data available.')
    ).toBeInTheDocument();
    expect(screen.getByText('No outcomes yet: v4, v5')).toBeInTheDocument();
  });

  it('the newest version line uses the ink colour and an older version line is dashed', () => {
    const { container } = render(<CumulativePanel data={mockCumulative} />);

    // In mockTheme: text (ink) is '#0F1114', crosshair is '#7C8490'
    const curves = container.querySelectorAll('.recharts-line-curve');
    expect(curves.length).toBe(2);

    const newestLine = Array.from(curves).find(
      (el) => el.getAttribute('stroke') === '#0F1114'
    );
    expect(newestLine).toBeDefined();
    // Recharts renders solid line with stroke-dasharray="0px 0px" (or falsy)
    expect(
      newestLine?.getAttribute('stroke-dasharray') === null ||
        newestLine?.getAttribute('stroke-dasharray') === '0px 0px'
    ).toBe(true);

    const olderLine = Array.from(curves).find(
      (el) => el.getAttribute('stroke') === '#7C8490'
    );
    expect(olderLine).toBeDefined();
    expect(olderLine?.getAttribute('stroke-dasharray')).toBe('4 3');
  });
});
