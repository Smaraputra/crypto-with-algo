import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { TierPanel } from './TierPanel';
import type { CalibrationMeta, TierCalibrationRow } from '@/types/calibration';

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

vi.mock('recharts', async () => {
  const original = await vi.importActual('recharts');
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

const mockMeta: CalibrationMeta = {
  style: 'day_trading',
  interval: '1h',
  source: 'composite',
  symbol: null,
  configVersion: null,
  horizonBars: 24,
  costPercentRoundTrip: 0.16,
  costIsDefault: true,
  rowCount: 1200,
  bootstrapIterations: 1000,
  meanBlockLenBars: 48,
  minSamplesForEstimate: 30,
  minBlocksForCi: 10,
  overlapping: false,
  statusCounts: { resolved: 1000, pending: 100, unresolvable: 100 },
  resolvedFrom: Date.now(),
  resolvedTo: Date.now(),
  configVersions: [4],
};

const mockRows: TierCalibrationRow[] = [
  {
    tier: 'strong_buy',
    count: 150,
    meanPercent: 0.85,
    ciLowPercent: 0.2,
    ciHighPercent: 1.5,
    netMeanPercent: 0.69,
    netCiLowPercent: 0.04,
    netCiHighPercent: 1.34,
    winRate: 0.54,
    avgMfePercent: 1.2,
    avgMaePercent: 0.4,
    withheld: 'none',
  },
  {
    tier: 'buy',
    count: 200,
    meanPercent: 0.1,
    ciLowPercent: -0.2,
    ciHighPercent: 0.4,
    netMeanPercent: -0.06,
    netCiLowPercent: -0.36,
    netCiHighPercent: 0.24,
    winRate: 0.48,
    avgMfePercent: 0.8,
    avgMaePercent: 0.6,
    withheld: 'none',
  },
  {
    tier: 'strong_sell',
    count: 12,
    meanPercent: null,
    ciLowPercent: null,
    ciHighPercent: null,
    netMeanPercent: null,
    netCiLowPercent: null,
    netCiHighPercent: null,
    winRate: null,
    avgMfePercent: null,
    avgMaePercent: null,
    withheld: 'too-few-samples',
  },
  {
    tier: 'sell',
    count: 45,
    meanPercent: null,
    ciLowPercent: null,
    ciHighPercent: null,
    netMeanPercent: null,
    netCiLowPercent: null,
    netCiHighPercent: null,
    winRate: null,
    avgMfePercent: null,
    avgMaePercent: null,
    withheld: 'too-few-blocks',
  },
];

describe('TierPanel', () => {
  it('renders table rows and formats non-withheld tiers', () => {
    render(<TierPanel data={mockRows} meta={mockMeta} />);

    expect(screen.getByText('Strong buy')).toBeInTheDocument();
    expect(screen.getByText('+0.69%')).toBeInTheDocument();
    expect(screen.getByText('(+0.04% to +1.34%)')).toBeInTheDocument();
    expect(screen.getByText('54.0%')).toBeInTheDocument();
    expect(screen.getByText(/1,000 iterations/)).toBeInTheDocument();
  });

  it('shows withheld reason and still shows sample count for a withheld tier', () => {
    render(<TierPanel data={mockRows} meta={mockMeta} />);

    const sellRow = screen.getByText('Sell').closest('tr');
    expect(sellRow).not.toBeNull();
    expect(within(sellRow!).getByText('45')).toBeInTheDocument();
    expect(within(sellRow!).getByText('too few independent blocks')).toBeInTheDocument();

    const strongSellRow = screen.getByText('Strong sell').closest('tr');
    expect(strongSellRow).not.toBeNull();
    expect(within(strongSellRow!).getByText('12')).toBeInTheDocument();
    expect(within(strongSellRow!).getByText('below 30 samples')).toBeInTheDocument();
  });

  it('shows "No tier has enough samples for an estimate yet." and no chart when every tier is too-few-samples or too-few-blocks with non-null netMeanPercent on the latter', () => {
    const allWithheldRows: TierCalibrationRow[] = [
      {
        ...mockRows[0],
        withheld: 'too-few-samples',
        netMeanPercent: null,
        meanPercent: null,
      },
      {
        ...mockRows[1],
        withheld: 'too-few-blocks',
        netMeanPercent: 0.25,
        meanPercent: 0.35,
      },
      {
        ...mockRows[2],
        withheld: 'too-few-samples',
        netMeanPercent: null,
        meanPercent: null,
      },
      {
        ...mockRows[3],
        withheld: 'too-few-blocks',
        netMeanPercent: -0.15,
        meanPercent: -0.1,
      },
    ];

    render(<TierPanel data={allWithheldRows} meta={mockMeta} />);

    expect(
      screen.getByText('No tier has enough samples for an estimate yet.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('tier-expectancy-chart')).toBeNull();
    // The table stays
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('renders winRate 1 as 100.0%', () => {
    const rowsWithFullWinRate: TierCalibrationRow[] = [
      {
        ...mockRows[0],
        winRate: 1,
      },
    ];

    render(<TierPanel data={rowsWithFullWinRate} meta={mockMeta} />);
    expect(screen.getByText('100.0%')).toBeInTheDocument();
  });
});
