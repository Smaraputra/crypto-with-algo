import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { rechartsWithSizedContainer } from '@/test/recharts';
import { CumulativeReturnChart } from './CumulativeReturnChart';
import { ReliabilityChart } from './ReliabilityChart';
import { ReturnDistributionChart } from './ReturnDistributionChart';
import { TierExpectancyChart } from './TierExpectancyChart';
import type {
  CumulativeSeriesRow,
  DistributionResponse,
  ReliabilityPoint,
  TierCalibrationRow,
} from '@/types/calibration';

vi.mock('recharts', async (importOriginal) =>
  rechartsWithSizedContainer(await importOriginal<Record<string, unknown>>())
);

const HOUR = 3_600_000;

describe('TierExpectancyChart', () => {
  const tier = (overrides: Partial<TierCalibrationRow> = {}): TierCalibrationRow => ({
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
  });

  it('renders the plot when at least one tier has an estimate', () => {
    render(<TierExpectancyChart tiers={[tier()]} costPercent={0.16} />);

    expect(screen.getByTestId('tier-expectancy-chart')).toBeInTheDocument();
  });

  it('says so rather than drawing an empty plot when every estimate is withheld', () => {
    render(
      <TierExpectancyChart
        tiers={[tier({ netMeanPercent: null, withheld: 'too-few-samples' })]}
        costPercent={0.16}
      />
    );

    expect(screen.getByTestId('tier-expectancy-empty')).toBeInTheDocument();
  });

  it('states the cost the net figure is net of', () => {
    render(<TierExpectancyChart tiers={[tier()]} costPercent={0.16} />);

    expect(screen.getByText(/0\.16% round-trip cost estimate/)).toBeInTheDocument();
  });

  it('tells the reader what a whisker crossing zero means', () => {
    render(<TierExpectancyChart tiers={[tier()]} costPercent={0.16} />);

    expect(screen.getByText(/has not been shown to have an edge/)).toBeInTheDocument();
  });
});

describe('ReliabilityChart', () => {
  const point = (overrides: Partial<ReliabilityPoint> = {}): ReliabilityPoint => ({
    scoreLow: 20,
    scoreHigh: 30,
    scoreMid: 25,
    count: 400,
    meanPercent: 0.04,
    ciLowPercent: -0.01,
    ciHighPercent: 0.09,
    withheld: 'none',
    ...overrides,
  });

  it('renders when a bucket has an estimate', () => {
    render(<ReliabilityChart points={[point()]} buyCutoff={29} />);

    expect(screen.getByTestId('reliability-chart')).toBeInTheDocument();
  });

  it('falls back to a message when no bucket can be estimated', () => {
    render(<ReliabilityChart points={[point({ meanPercent: null })]} buyCutoff={29} />);

    expect(screen.getByTestId('reliability-empty')).toBeInTheDocument();
  });

  it('explains how to read the slope, including the inverted case', () => {
    render(<ReliabilityChart points={[point()]} buyCutoff={29} />);

    expect(screen.getByText(/downward means inverted/)).toBeInTheDocument();
  });
});

describe('ReturnDistributionChart', () => {
  const distribution: DistributionResponse = {
    binEdges: [-2, -1, 0, 1, 2],
    bins: [
      { low: -2, high: -1, counts: { buy: 3 } },
      { low: -1, high: 0, counts: { buy: 10 } },
      { low: 0, high: 1, counts: { buy: 12 } },
      { low: 1, high: 2, counts: { buy: 5 } },
    ],
    tiers: ['buy'],
    clipped: { buy: 2 },
  };

  it('reports the plotted count and the off-scale count separately', () => {
    render(<ReturnDistributionChart distribution={distribution} costPercent={0.16} />);

    expect(screen.getByText(/n=30/)).toBeInTheDocument();
    expect(screen.getByText(/\+2 off-scale/)).toBeInTheDocument();
  });

  it('explains what the shaded cost band means', () => {
    render(<ReturnDistributionChart distribution={distribution} costPercent={0.16} />);

    expect(screen.getByText(/could not have paid\s+for the trade/)).toBeInTheDocument();
  });

  it('renders one panel per tier present', () => {
    render(
      <ReturnDistributionChart
        distribution={{
          ...distribution,
          tiers: ['buy', 'sell'],
          bins: distribution.bins.map((bin) => ({ ...bin, counts: { ...bin.counts, sell: 1 } })),
        }}
        costPercent={0.16}
      />
    );

    expect(screen.getByTestId('distribution-buy')).toBeInTheDocument();
    expect(screen.getByTestId('distribution-sell')).toBeInTheDocument();
  });

  it('says so when there is nothing to plot', () => {
    render(
      <ReturnDistributionChart
        distribution={{ binEdges: [], bins: [], tiers: [], clipped: {} }}
        costPercent={0.16}
      />
    );

    expect(screen.getByTestId('distribution-empty')).toBeInTheDocument();
  });
});

describe('CumulativeReturnChart', () => {
  const series: CumulativeSeriesRow[] = [
    {
      configVersion: 7,
      count: 3,
      points: [
        { candleTimestamp: 0, cumulativePercent: 0.1, count: 1 },
        { candleTimestamp: HOUR, cumulativePercent: 0.05, count: 2 },
        { candleTimestamp: 2 * HOUR, cumulativePercent: 0.2, count: 3 },
      ],
    },
  ];

  it('labels the non-overlapping default as not an equity curve', () => {
    render(<CumulativeReturnChart series={series} overlapping={false} horizonBars={24} />);

    expect(screen.getByText(/not an equity curve/)).toBeInTheDocument();
    expect(screen.getByText(/at most one signal per symbol per/)).toBeInTheDocument();
  });

  it('warns explicitly that the overlapping path is not achievable', () => {
    render(<CumulativeReturnChart series={series} overlapping horizonBars={24} />);

    expect(screen.getByText(/not an achievable path/)).toBeInTheDocument();
  });

  it('renders one line per configVersion and names each in the legend', () => {
    render(
      <CumulativeReturnChart
        series={[...series, { ...series[0], configVersion: 6, count: 2 }]}
        overlapping={false}
        horizonBars={24}
      />
    );

    expect(screen.getByText('configVersion 7 (n=3)')).toBeInTheDocument();
    expect(screen.getByText('configVersion 6 (n=2)')).toBeInTheDocument();
  });

  it('says so when no actionable signal has resolved', () => {
    render(
      <CumulativeReturnChart
        series={[{ configVersion: 7, count: 0, points: [] }]}
        overlapping={false}
        horizonBars={24}
      />
    );

    expect(screen.getByTestId('cumulative-empty')).toBeInTheDocument();
  });
});
