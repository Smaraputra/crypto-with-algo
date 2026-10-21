import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SignalBoard } from './SignalBoard';
import type { LabResponse, LabV2Response, LabV3Response } from '@/lib/signals/lab/view';

const mockUseSignalLab = vi.fn();
const mockUseSignalLabV2 = vi.fn();
const mockUseSignalLabV3 = vi.fn();

vi.mock('@/hooks/useSignalLab', () => ({
  useSignalLab: () => mockUseSignalLab(),
}));

vi.mock('@/hooks/useSignalLabV2', () => ({
  useSignalLabV2: () => mockUseSignalLabV2(),
}));

vi.mock('@/hooks/useSignalLabV3', () => ({
  useSignalLabV3: () => mockUseSignalLabV3(),
}));

function createFixture(): LabResponse {
  return {
    version: 'lab-v1',
    threshold: 800,
    hypotheses: [
      {
        id: 'L1-8h',
        candidate: 'L1',
        timeframe: '8h',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 120,
        betBars: 120,
        e: 1.84,
        e0: 1.1,
        threshold: 800,
        meanX: 0.041,
        meanB: 0.023,
        currentB: 0.019,
        latestBar: {
          barClose: '2026-10-19T16:00:00.000Z',
          late: false,
          coins: [
            { symbol: 'BTCUSDT', score: 90, rank: 1 },
            { symbol: 'ETHUSDT', score: 80, rank: 2 },
            { symbol: 'SOLUSDT', score: 70, rank: 3 },
            { symbol: 'BNBUSDT', score: 60, rank: 4 },
            { symbol: 'XRPUSDT', score: 50, rank: 5 },
            { symbol: 'ADAUSDT', score: 40, rank: 6 },
            { symbol: 'DOGEUSDT', score: 30, rank: 7 },
            { symbol: 'AVAXUSDT', score: 20, rank: 8 },
            { symbol: 'DOTUSDT', score: 10, rank: 9 },
            { symbol: 'LINKUSDT', score: 0, rank: 10 },
          ],
          skipped: [],
        },
      },
      {
        id: 'L2-5m',
        candidate: 'L2',
        timeframe: '5m',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 100,
        betBars: 90,
        e: 1.5,
        e0: 1.0,
        threshold: 800,
        meanX: 0.012,
        meanB: 0.05,
        currentB: 0.045,
        latestBar: null,
      },
      {
        id: 'L2-15m',
        candidate: 'L2',
        timeframe: '15m',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 50,
        betBars: 45,
        e: 2.1,
        e0: 1.2,
        threshold: 800,
        meanX: 0.018,
        meanB: 0.024,
        currentB: 0.02,
        latestBar: {
          barClose: '2026-10-19T15:45:00.000Z',
          late: false,
          coins: [
            { symbol: 'BTCUSDT', score: 20, rank: 1, parts: { v8: 25, rvRank: 2 } },
          ],
          skipped: [],
        },
      },
      {
        id: 'L2-1h',
        candidate: 'L2',
        timeframe: '1h',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 120,
        betBars: 120,
        e: 1.84,
        e0: 1.1,
        threshold: 800,
        meanX: 0.041,
        meanB: 0.023,
        currentB: 0.019,
        latestBar: {
          barClose: '2026-10-19T16:00:00.000Z',
          late: false,
          coins: [
            { symbol: 'BTCUSDT', score: 38, rank: 1, parts: { v8: 42, rvRank: 3 } },
            { symbol: 'ETHUSDT', score: 25, rank: 2, parts: { v8: 30, rvRank: 4 } },
            { symbol: 'BNBUSDT', score: 10, rank: 3, parts: { v8: 15, rvRank: 5 } },
            { symbol: 'SOLUSDT', score: 5, rank: 4, parts: { v8: 10, rvRank: 6 } },
            { symbol: 'XRPUSDT', score: 0, rank: 5, parts: { v8: 0, rvRank: 7 } },
            { symbol: 'ADAUSDT', score: -5, rank: 6, parts: { v8: -10, rvRank: 8 } },
            { symbol: 'DOGEUSDT', score: -10, rank: 7, parts: { v8: -15, rvRank: 9 } },
            { symbol: 'AVAXUSDT', score: -20, rank: 8, parts: { v8: -25, rvRank: 10 } },
            { symbol: 'DOTUSDT', score: -35, rank: 9, parts: { v8: -40, rvRank: 1 } },
          ],
          skipped: [{ symbol: 'LINKUSDT', reason: 'funding settlement missing' }],
        },
      },
      {
        id: 'L2-4h',
        candidate: 'L2',
        timeframe: '4h',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 30,
        betBars: 30,
        e: 3.5,
        e0: 1.5,
        threshold: 800,
        meanX: 0.03,
        meanB: 0.028,
        currentB: 0.025,
        latestBar: {
          barClose: '2026-10-19T16:00:00.000Z',
          late: false,
          coins: [
            { symbol: 'BTCUSDT', score: 15, rank: 3, parts: { v8: 10, rvRank: 4 } },
            { symbol: 'ETHUSDT', score: 45, rank: 1, parts: { v8: 50, rvRank: 1 } },
          ],
          skipped: [],
        },
      },
      {
        id: 'L2-1d',
        candidate: 'L2',
        timeframe: '1d',
        status: 'validated',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: '2027-03-02T12:00:00.000Z',
        gradedBars: 200,
        betBars: 200,
        e: 800,
        e0: 250,
        threshold: 800,
        meanX: 0.065,
        meanB: 0.026,
        currentB: 0.022,
        latestBar: {
          barClose: '2026-10-19T00:00:00.000Z',
          late: false,
          coins: [
            { symbol: 'BTCUSDT', score: 50, rank: 1, parts: { v8: 60, rvRank: 2 } },
          ],
          skipped: [],
        },
      },
      {
        id: 'L3-8h',
        candidate: 'L3',
        timeframe: '8h',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 100,
        betBars: 90,
        e: 2.2,
        e0: 1.0,
        threshold: 800,
        meanX: 0.015,
        meanB: 0.005,
        currentB: 0.004,
        latestBar: {
          barClose: '2026-10-19T16:00:00.000Z',
          late: false,
          coins: [
            { symbol: 'SOLUSDT', score: 85, rank: 1 },
            { symbol: 'BTCUSDT', score: 75, rank: 2 },
          ],
          skipped: [],
        },
      },
      {
        id: 'L4-8h',
        candidate: 'L4',
        timeframe: '8h',
        status: 'not_started',
        underTestSince: null,
        testEndsAt: null,
        validatedAt: null,
        gradedBars: 0,
        betBars: 0,
        e: 1,
        e0: 1,
        threshold: 800,
        meanX: null,
        meanB: null,
        currentB: null,
        latestBar: null,
      },
    ],
  };
}

function createV2Fixture(): LabV2Response {
  return {
    version: 'lab-v2',
    threshold: 400,
    hypotheses: [
      {
        id: 'N2-1w',
        candidate: 'N2',
        timeframe: '1w',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 20,
        betBars: 18,
        e: 2.45,
        threshold: 400,
        absorbed: false,
        meanNetReturn: 0.005,
        lastNetReturn: 0.006,
        scale: 0.13,
        latestBar: {
          barClose: '2026-10-19T00:00:00.000Z',
          late: false,
          positions: [{ symbol: 'BTCUSDT', weight: 0.32 }],
          cash: false,
        },
      },
      {
        id: 'N3-1d',
        candidate: 'N3',
        timeframe: '1d',
        status: 'under_test',
        underTestSince: '2026-10-19T00:00:00.000Z',
        testEndsAt: '2028-10-19T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 60,
        betBars: 50,
        e: 3.12,
        threshold: 400,
        absorbed: false,
        meanNetReturn: 0.01,
        lastNetReturn: 0.012,
        scale: 0.8,
        latestBar: {
          barClose: '2026-10-19T00:00:00.000Z',
          late: false,
          positions: [{ symbol: 'BTCUSDT', weight: 1 }],
          cash: false,
        },
      },
    ],
  };
}

function createV3Fixture(): LabV3Response {
  return {
    version: 'lab-v3',
    threshold: 200,
    hypotheses: [
      {
        id: 'F1-1d',
        candidate: 'F1',
        timeframe: '1d',
        status: 'under_test',
        underTestSince: '2026-10-21T00:00:00.000Z',
        testEndsAt: '2028-10-21T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 14,
        betBars: 14,
        e: 2.15,
        threshold: 200,
        absorbed: false,
        meanNetReturn: 0.0045,
        lastNetReturn: 0.005,
        scale: 0.02,
        latestBar: {
          barClose: '2026-10-21T00:00:00.000Z',
          late: false,
          positions: [
            { symbol: 'ETHUSDT', weight: 0.14 },
            { symbol: 'SOLUSDT', weight: -0.14 },
          ],
          cash: false,
        },
      },
    ],
  };
}

describe('SignalBoard', () => {
  beforeEach(() => {
    mockUseSignalLab.mockReset();
    mockUseSignalLabV2.mockReset();
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createV2Fixture(),
    });
    mockUseSignalLabV3.mockReset();
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createV3Fixture(),
    });
  });

  it('renders loading state with status role', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: true,
      data: undefined,
      error: null,
      refetch: vi.fn(),
    });
    render(<SignalBoard />);

    const statusEl = screen.getByRole('status');
    expect(statusEl).toHaveTextContent('Loading the lab record.');
    expect(screen.getByText('Forward signal lab, lab-v1')).toBeInTheDocument();
  });

  it('renders error state and retries on click', () => {
    const refetch = vi.fn();
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('Network timeout'),
      refetch,
    });
    render(<SignalBoard />);

    expect(
      screen.getByText('Could not load the lab record: Network timeout.')
    ).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state text when nothing is recorded yet', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          {
            id: 'L1-8h',
            candidate: 'L1',
            timeframe: '8h',
            status: 'not_started',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 0,
            betBars: 0,
            e: 1,
            e0: 1,
            threshold: 800,
            meanX: null,
            meanB: null,
            currentB: null,
            latestBar: null,
          },
        ],
      },
    });
    render(<SignalBoard />);

    expect(
      screen.getByText(
        'No lab bar has been recorded yet. The jobs write L2 within minutes of each 5m to 1d close, and L1, L3 and L4 at 00:03, 08:03 and 16:03 UTC.'
      )
    ).toBeInTheDocument();
  });

  it('renders table with 10 row headers and 5 column headers, showing known cell and skipped coin', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<SignalBoard />);

    const table = screen.getByTestId('signal-lab-table');
    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders).toHaveLength(10);

    const colHeaders = within(table).getAllByRole('columnheader');
    expect(colHeaders).toHaveLength(5);

    const cell = within(table).getByText('+38').closest('td')!;
    expect(within(cell).getByText('+38')).toBeInTheDocument();
    expect(within(cell).getByText('#1')).toBeInTheDocument();
    expect(within(cell).getByText('v8 +42, rv #3')).toBeInTheDocument();

    expect(within(table).getByText('skipped')).toBeInTheDocument();
  });

  it('applies text-bullish to top-2, text-bearish to bottom-2, and neither to middle scores', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<SignalBoard />);

    const table = screen.getByTestId('signal-lab-table');

    const top1 = within(table).getByText('+38');
    const top2 = within(table).getByText('+25');
    expect(top1).toHaveClass('text-bullish');
    expect(top1).not.toHaveClass('text-bearish');
    expect(top2).toHaveClass('text-bullish');
    expect(top2).not.toHaveClass('text-bearish');

    const bottom2 = within(table).getByText('-20');
    const bottom1 = within(table).getByText('-35');
    expect(bottom2).toHaveClass('text-bearish');
    expect(bottom2).not.toHaveClass('text-bullish');
    expect(bottom1).toHaveClass('text-bearish');
    expect(bottom1).not.toHaveClass('text-bullish');

    const middle = within(table).getByText('+10');
    expect(middle).not.toHaveClass('text-bullish');
    expect(middle).not.toHaveClass('text-bearish');
  });

  it('renders status lines correctly', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<SignalBoard />);

    expect(screen.getAllByText('Under test since 2026-10-19').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Validated (forward, 2027-03-02)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0);
  });

  it('formats E value, sets aria-valuenow, and sets fill widths for E 1 and E 800', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<SignalBoard />);

    expect(screen.getAllByText('E 1.84 of 800').length).toBeGreaterThan(0);

    const meter184 = screen.getByRole('meter', {
      name: /e-value of L1 rv-v1 composite, 8h/i,
    });
    expect(meter184).toHaveAttribute('aria-valuenow', '1.84');

    const meter1 = screen.getByRole('meter', {
      name: /e-value of L4 positioning fade, 8h/i,
    });
    expect(meter1).toHaveAttribute('aria-valuenow', '1');
    expect(meter1.firstElementChild).toHaveStyle({ width: '0%' });

    const meter800 = screen.getByRole('meter', {
      name: /e-value of L2 combined score, 1d/i,
    });
    expect(meter800).toHaveAttribute('aria-valuenow', '800');
    expect(meter800.firstElementChild).toHaveStyle({ width: '100%' });
  });

  it('handles mobile timeframe buttons and switches displayed scores', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<SignalBoard />);

    const mobile = screen.getByTestId('signal-lab-mobile');
    const btn1h = within(mobile).getByRole('button', { name: '1h' });
    const btn4h = within(mobile).getByRole('button', { name: '4h' });

    expect(btn1h).toHaveAttribute('aria-pressed', 'true');
    expect(btn4h).toHaveAttribute('aria-pressed', 'false');

    expect(within(mobile).getByText('+38')).toBeInTheDocument();
    expect(within(mobile).queryByText('+15')).not.toBeInTheDocument();

    fireEvent.click(btn4h);

    expect(btn1h).toHaveAttribute('aria-pressed', 'false');
    expect(btn4h).toHaveAttribute('aria-pressed', 'true');

    expect(within(mobile).queryByText('+38')).not.toBeInTheDocument();
    expect(within(mobile).getByText('+15')).toBeInTheDocument();
  });

  it('renders without semicolons or long dashes in visible text', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<SignalBoard />);

    const board = screen.getByTestId('signal-lab-board');
    expect(board.textContent).not.toMatch(/[;–—]/);
  });

  it('renders the lab-v2 section', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createV2Fixture(),
    });
    render(<SignalBoard />);

    expect(screen.getByText('Forward lab, lab-v2 (Round 1 survivors)')).toBeInTheDocument();
    expect(screen.getByText('N2 weekly ridge')).toBeInTheDocument();
    expect(screen.getByText('N3 value-area drift')).toBeInTheDocument();
  });

  it('renders the lab-v3 section', () => {
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createV3Fixture(),
    });
    render(<SignalBoard />);

    expect(screen.getByText('Forward lab, lab-v3 (Round 2 Funding Level Carry)')).toBeInTheDocument();
    expect(screen.getByText('F1 weekly staggered funding level carry')).toBeInTheDocument();
    expect(screen.getByText('ETH +0.14')).toBeInTheDocument();
    expect(screen.getByText('SOL -0.14')).toBeInTheDocument();
  });
});
