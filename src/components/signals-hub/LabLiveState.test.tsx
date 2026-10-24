import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LabLiveState } from './LabLiveState';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useSignalLabV3 } from '@/hooks/useSignalLabV3';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';

vi.mock('@/hooks/useSignalLab', () => ({
  useSignalLab: vi.fn(),
}));

vi.mock('@/hooks/useSignalLabV2', () => ({
  useSignalLabV2: vi.fn(),
}));

vi.mock('@/hooks/useSignalLabV3', () => ({
  useSignalLabV3: vi.fn(),
}));

vi.mock('@/hooks/useSignalLabV4', () => ({
  useSignalLabV4: vi.fn(),
}));

describe('LabLiveState', () => {
  const refetch1 = vi.fn();
  const refetch2 = vi.fn();
  const refetch3 = vi.fn();
  const refetch4 = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useSignalLab).mockReturnValue({
      data: {
        version: 'lab-v1',
        threshold: 100,
        hypotheses: [
          {
            id: 'L1-8h',
            candidate: 'L1',
            timeframe: '8h',
            status: 'under_test',
            underTestSince: '2026-10-18T00:00:00.000Z',
            testEndsAt: '2028-10-18T00:00:00.000Z',
            validatedAt: null,
            gradedBars: 50,
            betBars: 42,
            e: 12.3456,
            e0: 5,
            threshold: 100,
            meanX: 0.1,
            meanB: 0.05,
            currentB: 0.02,
            latestBar: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: refetch1,
    } as unknown as ReturnType<typeof useSignalLab>);

    vi.mocked(useSignalLabV2).mockReturnValue({
      data: {
        version: 'lab-v2',
        threshold: 100,
        hypotheses: [],
      },
      isLoading: false,
      isError: false,
      refetch: refetch2,
    } as unknown as ReturnType<typeof useSignalLabV2>);

    vi.mocked(useSignalLabV3).mockReturnValue({
      data: {
        version: 'lab-v3',
        threshold: 100,
        hypotheses: [],
      },
      isLoading: false,
      isError: false,
      refetch: refetch3,
    } as unknown as ReturnType<typeof useSignalLabV3>);

    vi.mocked(useSignalLabV4).mockReturnValue({
      data: {
        version: 'lab-v4',
        threshold: 100,
        hypotheses: [],
      },
      isLoading: false,
      isError: false,
      refetch: refetch4,
    } as unknown as ReturnType<typeof useSignalLabV4>);
  });

  it('renders a found hypothesis with evidence, threshold, bets and date', () => {
    render(<LabLiveState hypothesisIds={['L1-8h']} />);

    expect(screen.getByRole('heading', { name: 'Live state' })).toBeInTheDocument();
    expect(screen.getByText('L1-8h')).toBeInTheDocument();
    expect(screen.getByText('Under test')).toBeInTheDocument();
    expect(screen.getByText('Evidence 12.35 of 100, 42 bets, since 2026-10-18')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Open the lab record' });
    expect(link).toHaveAttribute('href', '/lab');
  });

  it('renders "n/a" for a missing hypothesis', () => {
    render(<LabLiveState hypothesisIds={['L1-8h', 'MISSING-99']} />);

    expect(screen.getByText('MISSING-99')).toBeInTheDocument();
    expect(screen.getByText('n/a')).toBeInTheDocument();
  });

  it('renders grey placeholder rows when loading', () => {
    vi.mocked(useSignalLab).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: refetch1,
    } as unknown as ReturnType<typeof useSignalLab>);

    render(<LabLiveState hypothesisIds={['L1-8h', 'L2-1h']} />);

    expect(screen.getByTestId('lab-loading-skeleton')).toBeInTheDocument();
    const rows = screen.getAllByTestId('lab-placeholder-row');
    expect(rows).toHaveLength(2);
  });

  it('renders error notice and retry button when an error occurs', async () => {
    const user = userEvent.setup();
    vi.mocked(useSignalLab).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetch1,
    } as unknown as ReturnType<typeof useSignalLab>);

    render(<LabLiveState hypothesisIds={['L1-8h']} />);

    expect(screen.getByText('Live state did not load.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Try again' });
    expect(retryBtn).toBeInTheDocument();

    await user.click(retryBtn);
    expect(refetch1).toHaveBeenCalled();
  });
});
