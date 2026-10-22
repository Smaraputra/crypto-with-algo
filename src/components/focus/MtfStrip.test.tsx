import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MtfStrip } from './MtfStrip';
import type { FocusMtfResponse } from '@/hooks/useFocusMtf';

const { mockUseFocusMtf } = vi.hoisted(() => ({
  mockUseFocusMtf: vi.fn(),
}));

vi.mock('@/hooks/useFocusMtf', () => ({
  useFocusMtf: (symbol: string) => mockUseFocusMtf(symbol),
}));

describe('MtfStrip', () => {
  const refetch = vi.fn();
  const now = Date.now();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    mockUseFocusMtf.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
      refetch,
    });

    render(<MtfStrip symbol="BTCUSDT" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading timeframes...');
    expect(screen.getByText('Timeframes')).toBeInTheDocument();
    expect(screen.getByText('Untested')).toBeInTheDocument();
  });

  it('renders error state and retries on click', () => {
    mockUseFocusMtf.mockReturnValue({
      isLoading: false,
      error: new Error('Failed to fetch MTF data'),
      data: undefined,
      refetch,
    });

    render(<MtfStrip symbol="BTCUSDT" />);

    expect(
      screen.getByText('Could not load timeframes: Failed to fetch MTF data.')
    ).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toHaveClass('min-h-11');
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state when there are no states', () => {
    mockUseFocusMtf.mockReturnValue({
      isLoading: false,
      error: null,
      data: { symbol: 'BTCUSDT', states: [], priorDay: null },
      refetch,
    });

    render(<MtfStrip symbol="BTCUSDT" />);

    expect(screen.getByText('No timeframe data available.')).toBeInTheDocument();
  });

  it('renders all rows and exact texts for data state', () => {
    const fixture: FocusMtfResponse = {
      symbol: 'BTCUSDT',
      priorDay: null,
      states: [
        {
          interval: '15m',
          asOf: now,
          trend: 1,
          lastEvent: {
            type: 'BOS',
            direction: 'bull',
            level: 50000,
            pivotIndex: 10,
            breakIndex: 15,
            breakTimestamp: now - 3600_000 - 900_000, // closed 1h ago
          },
          cvdSlope: 'rising',
          priceVsSma: 'above',
        },
        {
          interval: '1h',
          asOf: now,
          trend: -1,
          lastEvent: {
            type: 'CHoCH',
            direction: 'bear',
            level: 51000,
            pivotIndex: 5,
            breakIndex: 12,
            breakTimestamp: now - 7200_000 - 3600_000, // closed 2h ago
          },
          cvdSlope: 'falling',
          priceVsSma: 'below',
        },
        {
          interval: '4h',
          asOf: now,
          trend: 0,
          lastEvent: null,
          cvdSlope: 'flat',
          priceVsSma: null,
        },
        {
          interval: '1d',
          error: true,
        },
      ],
    };

    mockUseFocusMtf.mockReturnValue({
      isLoading: false,
      error: null,
      data: fixture,
      refetch,
    });

    render(<MtfStrip symbol="BTCUSDT" />);

    // Heading and Tag
    expect(screen.getByText('Timeframes')).toBeInTheDocument();
    expect(screen.getByText('Untested')).toBeInTheDocument();

    // 15m row
    const row15m = screen.getByTestId('mtf-row-15m');
    expect(row15m).toHaveTextContent('Up');
    expect(row15m).toHaveTextContent('BOS up, 1h ago');
    expect(row15m).toHaveTextContent('CVD rising');
    expect(row15m).toHaveTextContent('Above 50 SMA');
    expect(screen.getByText('Up')).toHaveClass('text-bullish');

    // 1h row
    const row1h = screen.getByTestId('mtf-row-1h');
    expect(row1h).toHaveTextContent('Down');
    expect(row1h).toHaveTextContent('CHoCH down, 2h ago');
    expect(row1h).toHaveTextContent('CVD falling');
    expect(row1h).toHaveTextContent('Below 50 SMA');
    expect(screen.getByText('Down')).toHaveClass('text-bearish');

    // 4h row
    const row4h = screen.getByTestId('mtf-row-4h');
    expect(row4h).toHaveTextContent('No trend');
    expect(row4h).toHaveTextContent('None yet');
    expect(row4h).toHaveTextContent('CVD flat');
    expect(row4h).toHaveTextContent('SMA n/a');
    expect(screen.getByText('No trend')).toHaveClass('text-muted-foreground');

    // 1d row (error)
    const row1d = screen.getByTestId('mtf-row-1d');
    expect(row1d).toHaveTextContent('Unavailable');

    // Footer
    expect(
      screen.getByText('Closed bars only. A swing confirms 20 bars after it forms.')
    ).toBeInTheDocument();
  });

  it('computes event age from the break bar close timestamp for a 1d row', () => {
    const fixture: FocusMtfResponse = {
      symbol: 'BTCUSDT',
      priorDay: null,
      states: [
        {
          interval: '1d',
          asOf: now,
          trend: 1,
          lastEvent: {
            type: 'BOS',
            direction: 'bull',
            level: 65000,
            pivotIndex: 10,
            breakIndex: 15,
            breakTimestamp: now - 86_400_000 - 2 * 3600_000, // break bar opened 26h ago, closed 2h ago
          },
          cvdSlope: 'rising',
          priceVsSma: 'above',
        },
      ],
    };

    mockUseFocusMtf.mockReturnValue({
      isLoading: false,
      error: null,
      data: fixture,
      refetch,
    });

    render(<MtfStrip symbol="BTCUSDT" />);

    const row1d = screen.getByTestId('mtf-row-1d');
    expect(row1d).toHaveTextContent('BOS up, 2h ago');
  });

  it('renders perpetual contract warning and retry button when every row has error: true', () => {
    mockUseFocusMtf.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        symbol: 'NONPERP',
        priorDay: null,
        states: [
          { interval: '15m', error: true },
          { interval: '1h', error: true },
          { interval: '4h', error: true },
          { interval: '1d', error: true },
        ],
      },
      refetch,
    });

    render(<MtfStrip symbol="NONPERP" />);

    expect(
      screen.getByText(
        'No USDT-M perpetual data for this coin. It may not have a perp contract.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByTestId('mtf-row-15m')).not.toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toBeInTheDocument();
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
