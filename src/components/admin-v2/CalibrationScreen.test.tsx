import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { CalibrationScreen } from './CalibrationScreen';
import { useCalibration } from '@/hooks/useCalibration';
import type { CalibrationResponse } from '@/types/calibration';

vi.mock('@/hooks/useCalibration', () => ({
  useCalibration: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/calibration',
}));

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

const mockCalibrationData: CalibrationResponse = {
  meta: {
    style: 'day_trading',
    interval: '1h',
    source: 'composite',
    symbol: null,
    configVersion: null,
    horizonBars: 24,
    costPercentRoundTrip: 0.16,
    costIsDefault: true,
    rowCount: 500,
    bootstrapIterations: 1000,
    meanBlockLenBars: 48,
    minSamplesForEstimate: 30,
    minBlocksForCi: 10,
    overlapping: false,
    statusCounts: { resolved: 400, pending: 50, unresolvable: 50 },
    resolvedFrom: 1728000000000,
    resolvedTo: 1729000000000,
    configVersions: [4, 5],
  },
  tiers: [
    {
      tier: 'buy',
      count: 120,
      meanPercent: 0.5,
      ciLowPercent: 0.1,
      ciHighPercent: 0.9,
      netMeanPercent: 0.34,
      netCiLowPercent: -0.06,
      netCiHighPercent: 0.74,
      winRate: 0.52,
      avgMfePercent: 0.9,
      avgMaePercent: 0.4,
      withheld: 'none',
    },
  ],
  reliability: [
    {
      scoreLow: 25,
      scoreHigh: 35,
      scoreMid: 30,
      count: 80,
      meanPercent: 0.6,
      ciLowPercent: 0.2,
      ciHighPercent: 1.0,
      withheld: 'none',
    },
  ],
  distribution: {
    binEdges: [-1, 0, 1],
    bins: [
      {
        low: -1,
        high: 0,
        counts: { buy: 20 },
      },
      {
        low: 0,
        high: 1,
        counts: { buy: 60 },
      },
    ],
    tiers: ['buy'],
    clipped: {},
  },
  cumulative: [
    {
      configVersion: 4,
      count: 50,
      points: [
        { candleTimestamp: 1728000000000, cumulativePercent: 0.5, count: 25 },
        { candleTimestamp: 1728086400000, cumulativePercent: 1.2, count: 25 },
      ],
    },
  ],
};

describe('CalibrationScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders header, the not-a-backtest line, and marks current tab', () => {
    vi.mocked(useCalibration).mockReturnValue({
      data: mockCalibrationData,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useCalibration>);

    render(<CalibrationScreen />);

    // Rule 6: Not a backtest line
    expect(
      screen.getByText('A record of live price score outcomes after costs. Not a backtest.')
    ).toBeInTheDocument();

    // Page title
    expect(screen.getByRole('heading', { level: 1, name: 'Calibration' })).toBeInTheDocument();

    // AdminTabs marks current page
    const currentTab = screen.getByRole('link', { name: 'Calibration' });
    expect(currentTab).toHaveAttribute('aria-current', 'page');
  });

  it('renders loading state notice when query is loading', () => {
    vi.mocked(useCalibration).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useCalibration>);

    render(<CalibrationScreen />);

    expect(screen.getByText('Loading calibration...')).toBeInTheDocument();
    expect(screen.getByTestId('skeleton-rows')).toBeInTheDocument();
  });

  it('renders error state with "Calibration did not load." and "Try again" action', () => {
    const refetch = vi.fn();
    vi.mocked(useCalibration).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network error'),
      refetch,
    } as unknown as ReturnType<typeof useCalibration>);

    render(<CalibrationScreen />);

    expect(screen.getByText('Calibration did not load.')).toBeInTheDocument();
    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    expect(tryAgainBtn).toBeInTheDocument();

    fireEvent.click(tryAgainBtn);
    expect(refetch).toHaveBeenCalled();
  });

  it('renders empty state when resolved count is zero', () => {
    const emptyData: CalibrationResponse = {
      ...mockCalibrationData,
      meta: {
        ...mockCalibrationData.meta,
        statusCounts: { resolved: 0, pending: 10, unresolvable: 0 },
      },
      tiers: [],
    };

    vi.mocked(useCalibration).mockReturnValue({
      data: emptyData,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useCalibration>);

    render(<CalibrationScreen />);

    expect(
      screen.getByText('No resolved outcomes for this style, interval and source.')
    ).toBeInTheDocument();
  });
});
