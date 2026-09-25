import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { rechartsWithSizedContainer } from '@/test/recharts';
import { CalibrationDashboard } from './CalibrationDashboard';
import type { CalibrationResponse } from '@/types/calibration';

vi.mock('recharts', async (importOriginal) =>
  rechartsWithSizedContainer(await importOriginal<Record<string, unknown>>())
);

const response: CalibrationResponse = {
  meta: {
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
    statusCounts: { pending: 240, resolved: 2200, unresolvable: 0 },
    resolvedFrom: Date.UTC(2026, 8, 17),
    resolvedTo: Date.UTC(2026, 8, 25),
    configVersions: [6, 7],
  },
  tiers: [
    {
      tier: 'buy',
      count: 900,
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
    },
  ],
  reliability: [
    {
      scoreLow: 20,
      scoreHigh: 30,
      scoreMid: 25,
      count: 400,
      meanPercent: 0.04,
      ciLowPercent: -0.01,
      ciHighPercent: 0.09,
      withheld: 'none',
    },
  ],
  distribution: {
    binEdges: [-1, 0, 1],
    bins: [
      { low: -1, high: 0, counts: { buy: 10 } },
      { low: 0, high: 1, counts: { buy: 12 } },
    ],
    tiers: ['buy'],
    clipped: {},
  },
  cumulative: [
    {
      configVersion: 7,
      count: 2,
      points: [
        { candleTimestamp: 0, cumulativePercent: 0.1, count: 1 },
        { candleTimestamp: 3_600_000, cumulativePercent: 0.2, count: 2 },
      ],
    },
  ],
};

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('CalibrationDashboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Fresh Response per call: a body can only be read once, so a shared
    // instance breaks the moment a filter change triggers a second fetch.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(response), { status: 200 }))
    );
  });

  it('defaults to day_trading at 1h, the pair the paper-desk decision turns on', async () => {
    render(<CalibrationDashboard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('coverage-header')).toBeInTheDocument());

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('style=day_trading');
    expect(url).toContain('interval=1h');
    expect(url).toContain('source=composite');
  });

  it('resets the interval when the new style does not score the current one', async () => {
    render(<CalibrationDashboard />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('coverage-header')).toBeInTheDocument());

    // swing_trading scores 4h and 1d, never 1h -- leaving 1h selected would ask
    // the route for a block that does not exist.
    fireEvent.change(screen.getByTestId('style-select'), { target: { value: 'swing_trading' } });

    await waitFor(() => {
      expect((screen.getByTestId('interval-select') as HTMLSelectElement).value).toBe('4h');
    });
  });

  it('keeps the interval when the new style also scores it', async () => {
    render(<CalibrationDashboard />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('coverage-header')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('interval-select'), { target: { value: '15m' } });
    fireEvent.change(screen.getByTestId('style-select'), { target: { value: 'day_trading' } });

    expect((screen.getByTestId('interval-select') as HTMLSelectElement).value).toBe('15m');
  });

  it('offers only the versions present in the record', async () => {
    render(<CalibrationDashboard />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('coverage-header')).toBeInTheDocument());

    const options = Array.from(
      (screen.getByTestId('config-version-select') as HTMLSelectElement).options
    ).map((option) => option.value);
    expect(options).toEqual(['', '6', '7']);
  });

  it('asks for the overlapping path only when the toggle is on', async () => {
    render(<CalibrationDashboard />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('coverage-header')).toBeInTheDocument());

    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).not.toContain('overlapping=true');

    fireEvent.click(screen.getByTestId('overlapping-toggle'));

    await waitFor(() => {
      const urls = vi.mocked(globalThis.fetch).mock.calls.map((call) => call[0] as string);
      expect(urls.some((url) => url.includes('overlapping=true'))).toBe(true);
    });
  });

  it('renders every view once the record loads', async () => {
    render(<CalibrationDashboard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('coverage-header')).toBeInTheDocument());
    expect(screen.getByTestId('tier-expectancy-chart')).toBeInTheDocument();
    expect(screen.getByTestId('tier-table')).toBeInTheDocument();
    expect(screen.getByTestId('reliability-chart')).toBeInTheDocument();
    expect(screen.getByTestId('return-distribution-chart')).toBeInTheDocument();
    expect(screen.getByTestId('cumulative-return-chart')).toBeInTheDocument();
  });

  it('shows an error state instead of an empty dashboard when the request fails', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    );

    render(<CalibrationDashboard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('calibration-error')).toBeInTheDocument());
  });
});
