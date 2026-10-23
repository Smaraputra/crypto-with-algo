import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeframesPanel } from './TimeframesPanel';
import type { FocusMtfResponse } from '@/hooks/useFocusMtf';

const mockUseFocusMtf = vi.fn();

vi.mock('@/hooks/useFocusMtf', () => ({
  useFocusMtf: () => mockUseFocusMtf(),
}));

describe('TimeframesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every row words for fixture states, error row, chip, and foot line', () => {
    const now = Date.now();
    const twoDaysAgo = now - 2 * 86_400_000;
    const oneDayAgo = now - 86_400_000;

    const fixtureData: FocusMtfResponse = {
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
            level: 65000,
            pivotIndex: 10,
            breakIndex: 30,
            breakTimestamp: twoDaysAgo,
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
            level: 66000,
            pivotIndex: 12,
            breakIndex: 32,
            breakTimestamp: oneDayAgo,
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
          priceVsSma: 'above',
        },
        {
          interval: '1d',
          error: true,
        },
      ],
    };

    mockUseFocusMtf.mockReturnValue({ data: fixtureData });

    render(<TimeframesPanel symbol="BTCUSDT" />);

    // Chip
    expect(screen.getByText('Untested')).toBeInTheDocument();

    // Foot line
    expect(
      screen.getByText('Closed bars only. A swing confirms 20 bars after it forms.')
    ).toBeInTheDocument();

    // 15m row
    const row15m = screen.getByTestId('timeframe-row-15m');
    expect(row15m).toHaveTextContent('15m');
    expect(row15m).toHaveTextContent('Up');
    expect(row15m).toHaveTextContent('Break up, 2d ago');
    expect(row15m).toHaveTextContent('CVD rising');
    expect(row15m).toHaveTextContent('Above 50 SMA');

    // 1h row
    const row1h = screen.getByTestId('timeframe-row-1h');
    expect(row1h).toHaveTextContent('1h');
    expect(row1h).toHaveTextContent('Down');
    expect(row1h).toHaveTextContent('Change of character down, 1d ago');
    expect(row1h).toHaveTextContent('CVD falling');
    expect(row1h).toHaveTextContent('Below 50 SMA');

    // 4h row
    const row4h = screen.getByTestId('timeframe-row-4h');
    expect(row4h).toHaveTextContent('4h');
    expect(row4h).toHaveTextContent('No trend');
    expect(row4h).toHaveTextContent('No event');
    expect(row4h).toHaveTextContent('CVD flat');

    // 1d error row
    const row1d = screen.getByTestId('timeframe-row-1d');
    expect(row1d).toHaveTextContent('1d');
    expect(row1d).toHaveTextContent('Did not load.');
  });
});
