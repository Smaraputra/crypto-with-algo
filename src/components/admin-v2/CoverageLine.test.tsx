import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { CoverageLine } from './CoverageLine';
import type { CalibrationMeta } from '@/types/calibration';

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
  statusCounts: {
    resolved: 1050,
    pending: 100,
    unresolvable: 50,
  },
  resolvedFrom: Date.UTC(2026, 9, 5), // Oct 5, 2026
  resolvedTo: Date.UTC(2026, 9, 20), // Oct 20, 2026
  configVersions: [4, 5, 6],
};

describe('CoverageLine', () => {
  it('renders with testid coverage-header and formats all items from meta', () => {
    render(<CoverageLine meta={mockMeta} />);

    expect(screen.getByTestId('coverage-header')).toBeInTheDocument();
    expect(
      screen.getByText(/1,050 resolved, 100 pending, 50 unresolvable/)
    ).toBeInTheDocument();
    expect(screen.getByText('Oct 5, 2026 to Oct 20, 2026')).toBeInTheDocument();
    expect(screen.getByText('24 bars')).toBeInTheDocument();
    expect(screen.getByText('0.16% (default)')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('renders n/a when resolved span dates are null', () => {
    const metaWithNullDates: CalibrationMeta = {
      ...mockMeta,
      resolvedFrom: null,
      resolvedTo: null,
      costIsDefault: false,
    };
    render(<CoverageLine meta={metaWithNullDates} />);

    expect(screen.getByText('n/a')).toBeInTheDocument();
    expect(screen.getByText('0.16%')).toBeInTheDocument();
  });

  it('renders 0.16 as "0.16%"', () => {
    const meta: CalibrationMeta = {
      ...mockMeta,
      costPercentRoundTrip: 0.16,
      costIsDefault: false,
    };
    render(<CoverageLine meta={meta} />);
    expect(screen.getByText('0.16%')).toBeInTheDocument();
  });
});
