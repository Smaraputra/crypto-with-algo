import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CoverageHeader } from './CoverageHeader';
import type { CalibrationMeta } from '@/types/calibration';

function meta(overrides: Partial<CalibrationMeta> = {}): CalibrationMeta {
  return {
    style: 'day_trading',
    interval: '1h',
    source: 'composite',
    symbol: null,
    configVersion: null,
    horizonBars: 24,
    costPercentRoundTrip: 0.16,
    costIsDefault: true,
    rowCount: 1800,
    bootstrapIterations: 1000,
    meanBlockLenBars: 24,
    minSamplesForEstimate: 30,
    minBlocksForCi: 8,
    overlapping: false,
    statusCounts: { pending: 240, resolved: 2200, unresolvable: 3 },
    resolvedFrom: Date.UTC(2026, 8, 17),
    resolvedTo: Date.UTC(2026, 8, 25),
    configVersions: [7],
    ...overrides,
  };
}

describe('CoverageHeader', () => {
  it('reports resolved and pending counts together, so coverage is not mistaken for a result', () => {
    render(<CoverageHeader meta={meta()} />);

    expect(screen.getByText('2,200')).toBeInTheDocument();
    expect(screen.getByText('240 pending')).toBeInTheDocument();
  });

  it('separates the whole record from the rows in the current view', () => {
    // A filtered view is a slice of the record; showing only one of the two
    // numbers is how "this scorer has no edge" gets confused with "this scorer
    // has barely run".
    render(<CoverageHeader meta={meta({ configVersion: 7 })} />);

    expect(screen.getByText('2,200')).toBeInTheDocument();
    expect(screen.getByText('1,800')).toBeInTheDocument();
    expect(screen.getByText('configVersion 7')).toBeInTheDocument();
  });

  it('warns when more than one configVersion is pooled', () => {
    render(<CoverageHeader meta={meta({ configVersion: null, configVersions: [5, 6, 7] })} />);

    const warning = screen.getByTestId('pooled-versions-warning');
    expect(warning).toHaveTextContent('configVersions 5, 6, 7');
    expect(warning).toHaveTextContent('different scorer');
  });

  it('does not warn once a single version is selected', () => {
    render(<CoverageHeader meta={meta({ configVersion: 7, configVersions: [5, 6, 7] })} />);

    expect(screen.queryByTestId('pooled-versions-warning')).not.toBeInTheDocument();
  });

  it('does not warn when only one version exists in the record', () => {
    render(<CoverageHeader meta={meta({ configVersion: null, configVersions: [7] })} />);

    expect(screen.queryByTestId('pooled-versions-warning')).not.toBeInTheDocument();
  });

  it('flags a record too thin to estimate from', () => {
    render(
      <CoverageHeader
        meta={meta({ rowCount: 11, statusCounts: { pending: 900, resolved: 11, unresolvable: 0 } })}
      />
    );

    expect(screen.getByTestId('thin-record-note')).toHaveTextContent('withheld below 30');
  });

  it('distinguishes the default cost estimate from an override', () => {
    const { rerender } = render(<CoverageHeader meta={meta()} />);
    expect(screen.getByText('taker estimate, both legs')).toBeInTheDocument();

    rerender(<CoverageHeader meta={meta({ costIsDefault: false, costPercentRoundTrip: 0 })} />);
    expect(screen.getByText('override')).toBeInTheDocument();
  });

  it('shows the block length beside the horizon it came from', () => {
    render(<CoverageHeader meta={meta()} />);

    expect(screen.getByText('24 bars')).toBeInTheDocument();
    expect(screen.getByText('at 1h, block length 24')).toBeInTheDocument();
  });
});
