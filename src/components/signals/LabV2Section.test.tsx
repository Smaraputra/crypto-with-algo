import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LabV2Section } from './LabV2Section';
import type { LabV2Response } from '@/lib/signals/lab/view';

const mockUseSignalLabV2 = vi.fn();

vi.mock('@/hooks/useSignalLabV2', () => ({
  useSignalLabV2: () => mockUseSignalLabV2(),
}));

function createFixture(): LabV2Response {
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

describe('LabV2Section', () => {
  beforeEach(() => {
    mockUseSignalLabV2.mockReset();
  });

  it('renders loading state with status role', () => {
    mockUseSignalLabV2.mockReturnValue({
      isLoading: true,
      data: undefined,
      error: null,
      refetch: vi.fn(),
    });
    render(<LabV2Section />);

    const statusEl = screen.getByRole('status');
    expect(statusEl).toHaveTextContent('Loading the lab record.');
    expect(screen.getByText('Forward lab, lab-v2 (Round 1 survivors)')).toBeInTheDocument();
  });

  it('renders error state and retries on click', () => {
    const refetch = vi.fn();
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('Network timeout'),
      refetch,
    });
    render(<LabV2Section />);

    expect(screen.getByText('Could not load the lab record: Network timeout.')).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state text when nothing is recorded yet', () => {
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: {
        version: 'lab-v2',
        threshold: 400,
        hypotheses: [
          {
            id: 'N2-1w',
            candidate: 'N2',
            timeframe: '1w',
            status: 'not_started',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 0,
            betBars: 0,
            e: 1,
            threshold: 400,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.13,
            latestBar: null,
          },
        ],
      },
    });
    render(<LabV2Section />);

    expect(screen.getByText(/No lab bar has been recorded yet/)).toBeInTheDocument();
  });

  it('renders loaded state with both names, threshold 400, mean return text, and chips', () => {
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<LabV2Section />);

    expect(screen.getByText('Forward lab, lab-v2 (Round 1 survivors)')).toBeInTheDocument();
    expect(screen.getByText('N2 weekly ridge')).toBeInTheDocument();
    expect(screen.getByText('N3 value-area drift')).toBeInTheDocument();

    expect(screen.getByText('E 2.45 of 400')).toBeInTheDocument();
    expect(screen.getByText('E 3.12 of 400')).toBeInTheDocument();

    expect(screen.getByText('mean net return +0.500%')).toBeInTheDocument();
    expect(screen.getByText('mean net return +1.000%')).toBeInTheDocument();

    expect(screen.getByText('BTC +0.32')).toBeInTheDocument();
    expect(screen.getByText('BTC long')).toBeInTheDocument();
  });

  it('renders Cash chip when hypothesis has cash true or no positions', () => {
    const fixture = createFixture();
    fixture.hypotheses[0].latestBar = {
      barClose: '2026-10-19T00:00:00.000Z',
      late: false,
      positions: [],
      cash: true,
    };

    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: fixture,
    });
    render(<LabV2Section />);

    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('renders absorbed text in bearish token and meter value 0', () => {
    const fixture = createFixture();
    fixture.hypotheses[0].absorbed = true;
    fixture.hypotheses[0].e = 0;

    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: fixture,
    });
    render(<LabV2Section />);

    const absorbedEl = screen.getByText(
      "Stopped: a loss beyond the test's bound ended this test"
    );
    expect(absorbedEl).toBeInTheDocument();
    expect(absorbedEl).toHaveClass('text-bearish');

    const meter = screen.getByRole('meter', {
      name: /e-value of N2 weekly ridge/i,
    });
    expect(meter).toHaveAttribute('aria-valuenow', '0');
  });

  it('renders without semicolons or long dashes in visible text', () => {
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<LabV2Section />);

    const section = screen.getByTestId('signal-lab-v2-section');
    expect(section.textContent).not.toMatch(/[;–—]/);
  });
});
