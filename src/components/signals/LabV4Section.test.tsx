import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LabV4Section } from './LabV4Section';
import type { LabV4Response } from '@/lib/signals/lab/view';

const mockUseSignalLabV4 = vi.fn();

vi.mock('@/hooks/useSignalLabV4', () => ({
  useSignalLabV4: () => mockUseSignalLabV4(),
}));

function createFixture(): LabV4Response {
  return {
    version: 'lab-v4',
    threshold: 800,
    hypotheses: [
      {
        id: 'S1-1h',
        candidate: 'S1',
        timeframe: '1h',
        status: 'under_test',
        underTestSince: '2026-10-21T00:00:00.000Z',
        testEndsAt: '2028-10-21T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 24,
        betBars: 10,
        e: 1.45,
        threshold: 800,
        absorbed: false,
        meanNetReturn: -0.0012,
        meanNetPerTrade: -0.0010,
        lastNetReturn: -0.0005,
        scale: 0.15,
        openTrades: [
          {
            symbol: 'BTCUSDT',
            side: 1,
            enteredAt: '2026-10-22T06:10:00.000Z',
            exitsAt: '2026-10-22T14:10:00.000Z',
          },
        ],
        latestBar: {
          barClose: '2026-10-22T06:00:00.000Z',
          late: false,
          entries: [{ symbol: 'BTCUSDT', side: 1 }],
        },
      },
      {
        id: 'S2-1h',
        candidate: 'S2',
        timeframe: '1h',
        status: 'under_test',
        underTestSince: '2026-10-21T00:00:00.000Z',
        testEndsAt: '2028-10-21T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 24,
        betBars: 8,
        e: 0.95,
        threshold: 800,
        absorbed: false,
        meanNetReturn: -0.0009,
        meanNetPerTrade: -0.0008,
        lastNetReturn: 0.0002,
        scale: 0.14,
        openTrades: [],
        latestBar: {
          barClose: '2026-10-22T06:00:00.000Z',
          late: false,
          entries: [],
        },
      },
    ],
  };
}

describe('LabV4Section', () => {
  beforeEach(() => {
    mockUseSignalLabV4.mockReset();
  });

  it('renders loading state with status role', () => {
    mockUseSignalLabV4.mockReturnValue({
      isLoading: true,
      data: undefined,
      error: null,
      refetch: vi.fn(),
    });
    render(<LabV4Section />);

    const statusEl = screen.getByRole('status');
    expect(statusEl).toHaveTextContent('Loading the lab record.');
    expect(
      screen.getByText('Forward lab, lab-v4 (Round 3 structure and flow)')
    ).toBeInTheDocument();
  });

  it('renders error state and retries on click', () => {
    const refetch = vi.fn();
    mockUseSignalLabV4.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('Network timeout'),
      refetch,
    });
    render(<LabV4Section />);

    expect(
      screen.getByText('Could not load the lab record: Network timeout.')
    ).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toHaveClass('min-h-11');
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state text when nothing is recorded yet', () => {
    mockUseSignalLabV4.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          {
            id: 'S1-1h',
            candidate: 'S1',
            timeframe: '1h',
            status: 'not_started',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 0,
            betBars: 0,
            e: 1,
            threshold: 800,
            absorbed: false,
            meanNetReturn: null,
            meanNetPerTrade: null,
            lastNetReturn: null,
            scale: 0.15,
            openTrades: [],
            latestBar: null,
          },
        ],
      },
    });
    render(<LabV4Section />);

    expect(
      screen.getByText(/No lab bar has been recorded yet/)
    ).toBeInTheDocument();
  });

  it('renders loaded state with header, required text, hypotheses, E of 800, bets, and open trades', () => {
    mockUseSignalLabV4.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<LabV4Section />);

    expect(
      screen.getByText('Forward lab, lab-v4 (Round 3 structure and flow)')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Two rules on 1h perp bars, each trade held 8 hours: S1 trades a swing change of character confirmed by that bar's taker delta, S2 fades a taker-delta divergence at swing pivots. Both lost money on history after costs, so they are recorded forward by the owner's choice, not because they look promising."
      )
    ).toBeInTheDocument();

    expect(screen.getByText('S1 swing CHoCH flow confirm')).toBeInTheDocument();
    expect(screen.getByText('S2 delta divergence fade')).toBeInTheDocument();

    expect(screen.getByText('E 1.45 of 800')).toBeInTheDocument();
    expect(screen.getByText('bets 10')).toBeInTheDocument();
    expect(screen.getByText('mean net per bar -0.120%')).toBeInTheDocument();
    expect(screen.getByText('mean net per trade -0.100%')).toBeInTheDocument();

    expect(screen.getByText('BTC Long, exits at 14:10 UTC')).toBeInTheDocument();
    expect(screen.getByText('No open trades')).toBeInTheDocument();
  });

  it('renders absorbed text in bearish token', () => {
    const fixture = createFixture();
    fixture.hypotheses[0].absorbed = true;
    fixture.hypotheses[0].e = 0;

    mockUseSignalLabV4.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: fixture,
    });
    render(<LabV4Section />);

    const absorbedEl = screen.getByText(
      "Stopped: a loss beyond the test's bound ended this test"
    );
    expect(absorbedEl).toBeInTheDocument();
    expect(absorbedEl).toHaveClass('text-bearish');
  });

  it('renders without long dashes in visible text', () => {
    mockUseSignalLabV4.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<LabV4Section />);

    const section = screen.getByTestId('signal-lab-v4-section');
    expect(section.textContent).not.toMatch(/[–—]/);
  });
});
