import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TierTable } from './TierTable';
import type { TierCalibrationRow } from '@/types/calibration';

function row(overrides: Partial<TierCalibrationRow> = {}): TierCalibrationRow {
  return {
    tier: 'buy',
    count: 120,
    meanPercent: 0.08,
    ciLowPercent: -0.02,
    ciHighPercent: 0.18,
    netMeanPercent: -0.08,
    netCiLowPercent: -0.18,
    netCiHighPercent: 0.02,
    winRate: 0.51,
    avgMfePercent: 0.9,
    avgMaePercent: -0.8,
    withheld: 'none',
    ...overrides,
  };
}

describe('TierTable', () => {
  it('says so when there is nothing to show', () => {
    render(<TierTable tiers={[]} minSamples={30} />);

    expect(screen.getByTestId('tier-table-empty')).toBeInTheDocument();
  });

  it('marks an interval that spans zero, which is the whole point of showing it', () => {
    render(<TierTable tiers={[row()]} minSamples={30} />);

    expect(screen.getByText(/spans zero/)).toBeInTheDocument();
  });

  it('does not mark an interval that clears zero', () => {
    render(
      <TierTable
        tiers={[row({ netCiLowPercent: 0.05, netCiHighPercent: 0.2 })]}
        minSamples={30}
      />
    );

    expect(screen.queryByText(/spans zero/)).not.toBeInTheDocument();
  });

  it('explains a withheld estimate in words rather than blanking the cell', () => {
    render(
      <TierTable
        tiers={[
          row({
            count: 12,
            meanPercent: null,
            ciLowPercent: null,
            ciHighPercent: null,
            netMeanPercent: null,
            netCiLowPercent: null,
            netCiHighPercent: null,
            withheld: 'too-few-samples',
          }),
        ]}
        minSamples={30}
      />
    );

    expect(screen.getByText('below 30 samples')).toBeInTheDocument();
  });

  it('names the too-few-blocks case separately from too-few-samples', () => {
    render(
      <TierTable
        tiers={[row({ netCiLowPercent: null, netCiHighPercent: null, withheld: 'too-few-blocks' })]}
        minSamples={30}
      />
    );

    expect(screen.getByText('too few independent blocks')).toBeInTheDocument();
  });

  it('shows gross and net as separate columns, since the difference is the cost', () => {
    render(<TierTable tiers={[row()]} minSamples={30} />);

    expect(screen.getByText('+0.080%')).toBeInTheDocument();
    expect(screen.getByText('-0.080%')).toBeInTheDocument();
  });

  it('gives every tier row a text label, so identity never rests on the colour dot', () => {
    render(<TierTable tiers={[row({ tier: 'strong_sell' })]} minSamples={30} />);

    expect(screen.getByRole('rowheader', { name: /Strong sell/ })).toBeInTheDocument();
  });
});
