import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LabV3Section } from './LabV3Section';
import type { LabV3Response } from '@/lib/signals/lab/view';

const mockUseSignalLabV3 = vi.fn();

vi.mock('@/hooks/useSignalLabV3', () => ({
  useSignalLabV3: () => mockUseSignalLabV3(),
}));

function createFixture(): LabV3Response {
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

describe('LabV3Section', () => {
  beforeEach(() => {
    mockUseSignalLabV3.mockReset();
  });

  it('renders loading state with status role', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: true,
      data: undefined,
      error: null,
      refetch: vi.fn(),
    });
    render(<LabV3Section />);

    const statusEl = screen.getByRole('status');
    expect(statusEl).toHaveTextContent('Loading the lab record.');
    expect(screen.getByText('Forward lab, lab-v3 (Round 2 Funding Level Carry)')).toBeInTheDocument();
  });

  it('renders error state and retries on click', () => {
    const refetch = vi.fn();
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('Network timeout'),
      refetch,
    });
    render(<LabV3Section />);

    expect(screen.getByText('Could not load the lab record: Network timeout.')).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state text when nothing is recorded yet', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'not_started',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 0,
            betBars: 0,
            e: 1,
            threshold: 200,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.02,
            latestBar: null,
          },
        ],
      },
    });
    render(<LabV3Section />);

    expect(screen.getByText(/No lab bar has been recorded yet/)).toBeInTheDocument();
  });

  it('renders loaded state with F1 name, threshold 200, mean return text, and position chips', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<LabV3Section />);

    expect(screen.getByText('Forward lab, lab-v3 (Round 2 Funding Level Carry)')).toBeInTheDocument();
    expect(screen.getByText('F1 weekly staggered funding level carry')).toBeInTheDocument();

    expect(screen.getByText('E 2.15 of 200')).toBeInTheDocument();
    expect(screen.getByText('bets 14')).toBeInTheDocument();
    expect(screen.getByText('mean net return +0.450%')).toBeInTheDocument();

    expect(screen.getByText('ETH +0.14')).toBeInTheDocument();
    expect(screen.getByText('SOL -0.14')).toBeInTheDocument();
  });

  it('renders Cash chip when hypothesis has cash true or no positions', () => {
    const fixture = createFixture();
    fixture.hypotheses[0].latestBar = {
      barClose: '2026-10-21T00:00:00.000Z',
      late: false,
      positions: [],
      cash: true,
    };

    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: fixture,
    });
    render(<LabV3Section />);

    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('renders absorbed text in bearish token and meter value 0', () => {
    const fixture = createFixture();
    fixture.hypotheses[0].absorbed = true;
    fixture.hypotheses[0].e = 0;

    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: fixture,
    });
    render(<LabV3Section />);

    const absorbedEl = screen.getByText(
      "Stopped: a loss beyond the test's bound ended this test"
    );
    expect(absorbedEl).toBeInTheDocument();
    expect(absorbedEl).toHaveClass('text-bearish');

    const meter = screen.getByRole('meter', {
      name: /e-value of F1 weekly staggered funding level carry/i,
    });
    expect(meter).toHaveAttribute('aria-valuenow', '0');
  });

  it('renders without long dashes in visible text', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: createFixture(),
    });
    render(<LabV3Section />);

    const section = screen.getByTestId('signal-lab-v3-section');
    expect(section.textContent).not.toMatch(/[–—]/);
  });
});
