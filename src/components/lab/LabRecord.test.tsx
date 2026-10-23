import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LabRecord } from './LabRecord';
import * as useSignalLabModule from '@/hooks/useSignalLab';
import * as useSignalLabV2Module from '@/hooks/useSignalLabV2';
import * as useSignalLabV3Module from '@/hooks/useSignalLabV3';
import * as useSignalLabV4Module from '@/hooks/useSignalLabV4';
import * as useSignalsModule from '@/hooks/useSignals';
import { V8_STATUS } from '@/lib/signals/v8-status';

type LabV1QueryResult = ReturnType<typeof useSignalLabModule.useSignalLab>;
type LabV2QueryResult = ReturnType<typeof useSignalLabV2Module.useSignalLabV2>;
type LabV3QueryResult = ReturnType<typeof useSignalLabV3Module.useSignalLabV3>;
type LabV4QueryResult = ReturnType<typeof useSignalLabV4Module.useSignalLabV4>;
type CrossSectionalQueryResult = ReturnType<typeof useSignalsModule.useCrossSectionalLatest>;

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

vi.mock('@/hooks/useSignals', () => ({
  useCrossSectionalLatest: vi.fn(),
}));

describe('LabRecord', () => {
  const mockLabV1Data = {
    version: 'lab-v1' as const,
    threshold: 800,
    hypotheses: [
      {
        id: 'L3-8h',
        candidate: 'L3' as const,
        timeframe: '8h' as const,
        status: 'under_test' as const,
        underTestSince: '2026-01-01T00:00:00.000Z',
        testEndsAt: '2028-01-01T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 120,
        betBars: 14,
        e: 1.9,
        e0: 0,
        threshold: 800,
        meanX: 0.05,
        meanB: 0.02,
        currentB: 0.01,
        latestBar: {
          barClose: '2026-10-23T08:00:00.000Z',
          late: false,
          coins: [],
          skipped: [],
        },
      },
      {
        id: 'L1-8h',
        candidate: 'L1' as const,
        timeframe: '8h' as const,
        status: 'not_shown' as const,
        underTestSince: '2024-01-01T00:00:00.000Z',
        testEndsAt: '2026-01-01T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 200,
        betBars: 50,
        e: 12.4,
        e0: 0,
        threshold: 800,
        meanX: 0.01,
        meanB: 0.005,
        currentB: 0.002,
        latestBar: null,
      },
    ],
  };

  const mockLabV2Data = {
    version: 'lab-v2' as const,
    threshold: 400,
    hypotheses: [
      {
        id: 'N2-1w',
        candidate: 'N2' as const,
        timeframe: '1w' as const,
        status: 'under_test' as const,
        underTestSince: '2026-02-01T00:00:00.000Z',
        testEndsAt: '2028-02-01T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 30,
        betBars: 5,
        e: 1.1,
        threshold: 400,
        absorbed: false,
        meanNetReturn: 0.02,
        lastNetReturn: 0.01,
        scale: 0.13,
        latestBar: null,
      },
    ],
  };

  const mockLabV3Data = {
    version: 'lab-v3' as const,
    threshold: 200,
    hypotheses: [
      {
        id: 'F1-1d',
        candidate: 'F1' as const,
        timeframe: '1d' as const,
        status: 'not_started' as const,
        underTestSince: null,
        testEndsAt: null,
        validatedAt: null,
        gradedBars: 0,
        betBars: 0,
        e: 0,
        threshold: 200,
        absorbed: false,
        meanNetReturn: null,
        lastNetReturn: null,
        scale: 0.036,
        latestBar: null,
      },
    ],
  };

  const mockLabV4Data = {
    version: 'lab-v4' as const,
    threshold: 800,
    hypotheses: [
      {
        id: 'S1-1h',
        candidate: 'S1' as const,
        timeframe: '1h' as const,
        status: 'under_test' as const,
        underTestSince: '2026-03-01T00:00:00.000Z',
        testEndsAt: '2028-03-01T00:00:00.000Z',
        validatedAt: null,
        gradedBars: 80,
        betBars: 10,
        e: 2.5,
        threshold: 800,
        absorbed: false,
        meanNetReturn: 0.01,
        lastNetReturn: 0.005,
        scale: 0.15,
        openTrades: [],
        latestBar: null,
      },
    ],
  };

  const mockCrossSectionalData = {
    success: true as const,
    signal: null,
    step: null,
    completedStep: null,
    book: {
      bookName: 'rv-v1' as const,
      version: 'rv-v1' as const,
      validationStatus: 'rejected' as const,
      validationRef: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      startBarTime: null,
      lastStepBarTime: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
      tracks: {
        taker: { positions: {}, cash: 0 },
        maker: { positions: {}, cash: 0 },
      },
      equity: { taker: 8500, maker: 8800 },
      peakEquity: { taker: 10000, maker: 10000 },
      alerts: { drawdownTaker: true, drawdownMaker: false, negativeStreak: 3 },
      fillStats: {
        '00': { makerFilled: 0, makerFallback: 0, steps: 0 },
        '08': { makerFilled: 0, makerFallback: 0, steps: 0 },
        '16': { makerFilled: 0, makerFallback: 0, steps: 0 },
        weekday: { makerFilled: 0, makerFallback: 0, steps: 0 },
        weekend: { makerFilled: 0, makerFallback: 0, steps: 0 },
      },
    },
    costs: { takerFee: 0.0005, makerFee: 0.0002, takerSlippageBps: 5 },
    rule: {
      weights: { mom: 0.25, idio: 0.25, carry: 0.25, flow: 0.25 },
      legs: 4,
      startingEquity: 10000,
      drawdownFlag: 0.15,
    },
    lastAlert: null,
    legacy: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useSignalLabModule.useSignalLab).mockReturnValue({
      data: mockLabV1Data,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV1QueryResult);

    vi.mocked(useSignalLabV2Module.useSignalLabV2).mockReturnValue({
      data: mockLabV2Data,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV2QueryResult);

    vi.mocked(useSignalLabV3Module.useSignalLabV3).mockReturnValue({
      data: mockLabV3Data,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV3QueryResult);

    vi.mocked(useSignalLabV4Module.useSignalLabV4).mockReturnValue({
      data: mockLabV4Data,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV4QueryResult);

    vi.mocked(useSignalsModule.useCrossSectionalLatest).mockReturnValue({
      data: mockCrossSectionalData,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as CrossSectionalQueryResult);
  });

  it('renders mapped display names such as "Volatility fade, 8 hours" for L3-8h', () => {
    render(<LabRecord />);
    expect(screen.getByText('Volatility fade, 8 hours')).toBeInTheDocument();
    expect(screen.getByText('Relative value ranking, 8 hours')).toBeInTheDocument();
    expect(screen.getByText('Weekly trend, weekly')).toBeInTheDocument();
    expect(screen.getByText('Funding carry, daily')).toBeInTheDocument();
    expect(screen.getByText('Swing break with taker flow, hourly')).toBeInTheDocument();
  });

  it('renders not_shown hypotheses under a "Not shown" chip with the ended line', () => {
    render(<LabRecord />);
    const notShownChips = screen.getAllByText('Not shown');
    expect(notShownChips.length).toBeGreaterThan(0);
    expect(
      screen.getByText('Its 24 months ended without reaching the bar. It keeps no claim.')
    ).toBeInTheDocument();
  });

  it('renders "0 validated" and "No idea has been validated yet." when 0 are validated', () => {
    render(<LabRecord />);
    expect(screen.getByText('0 validated')).toBeInTheDocument();
    expect(screen.getByText(/No idea has been validated yet\./)).toBeInTheDocument();
  });

  it('renders "1 validated" without "No idea has been validated yet." when one is validated', () => {
    const validatedV1 = {
      ...mockLabV1Data,
      hypotheses: [
        {
          ...mockLabV1Data.hypotheses[0],
          status: 'validated' as const,
        },
      ],
    };

    vi.mocked(useSignalLabModule.useSignalLab).mockReturnValue({
      data: validatedV1,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV1QueryResult);

    render(<LabRecord />);
    expect(screen.getByText('1 validated')).toBeInTheDocument();
    expect(screen.queryByText(/No idea has been validated yet\./)).not.toBeInTheDocument();
  });

  it('Tape receives betCount and evidence/threshold giving fill width 0.2375% for 1.9 / 800', () => {
    render(<LabRecord />);
    const fills = screen.getAllByTestId('tape-fill');
    const fill800 = fills.find((f) => f.style.width === '0.2375%');
    expect(fill800).toBeDefined();
  });

  it('renders loading state notice when a hook is loading', () => {
    vi.mocked(useSignalLabModule.useSignalLab).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV1QueryResult);

    render(<LabRecord />);
    expect(screen.getByText('Loading the lab record.')).toBeInTheDocument();
  });

  it('renders status group EvidenceChip in an h2 heading', () => {
    render(<LabRecord />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Under test' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Not started' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Not shown' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Rejected' })
    ).toBeInTheDocument();
  });

  it('renders error state notice and calls refetch on Try again', () => {
    const refetchMock = vi.fn();
    vi.mocked(useSignalLabModule.useSignalLab).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchMock,
    } as unknown as LabV1QueryResult);

    render(<LabRecord />);
    expect(screen.getByText('The lab record did not load.')).toBeInTheDocument();
    expect(
      screen.getByText('The lab service did not answer. Try again in a minute.')
    ).toBeInTheDocument();

    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(tryAgainBtn);
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it('with two failed queries shows exactly one error notice and clicking Try again calls both refetch mocks', () => {
    const refetchV1 = vi.fn();
    const refetchV2 = vi.fn();

    vi.mocked(useSignalLabModule.useSignalLab).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchV1,
    } as unknown as LabV1QueryResult);

    vi.mocked(useSignalLabV2Module.useSignalLabV2).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchV2,
    } as unknown as LabV2QueryResult);

    render(<LabRecord />);

    const errorNotices = screen.getAllByText('The lab record did not load.');
    expect(errorNotices).toHaveLength(1);

    // Rows from queries that did load (labV3, labV4) still render
    expect(screen.getByText('Funding carry, daily')).toBeInTheDocument();
    expect(screen.getByText('Swing break with taker flow, hourly')).toBeInTheDocument();

    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(tryAgainBtn);
    expect(refetchV1).toHaveBeenCalledTimes(1);
    expect(refetchV2).toHaveBeenCalledTimes(1);
  });

  it('shows lab-v4 row note exactly once', () => {
    render(<LabRecord />);
    const notes = screen.getAllByText(
      'Lost money on historical data. Recorded forward anyway, so the outcome is public.'
    );
    expect(notes).toHaveLength(1);
  });

  it('shows lab-v2 row note', () => {
    render(<LabRecord />);
    const notes = screen.getAllByText(
      'An effect this small is unlikely to be confirmed within 24 months.'
    );
    expect(notes).toHaveLength(1);
  });

  it('renders empty state notice when no hypotheses exist across all labs', () => {
    vi.mocked(useSignalLabModule.useSignalLab).mockReturnValue({
      data: { version: 'lab-v1', threshold: 800, hypotheses: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV1QueryResult);
    vi.mocked(useSignalLabV2Module.useSignalLabV2).mockReturnValue({
      data: { version: 'lab-v2', threshold: 400, hypotheses: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV2QueryResult);
    vi.mocked(useSignalLabV3Module.useSignalLabV3).mockReturnValue({
      data: { version: 'lab-v3', threshold: 200, hypotheses: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV3QueryResult);
    vi.mocked(useSignalLabV4Module.useSignalLabV4).mockReturnValue({
      data: { version: 'lab-v4', threshold: 800, hypotheses: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as LabV4QueryResult);

    render(<LabRecord />);
    expect(screen.getByText('No ideas are being tested right now.')).toBeInTheDocument();
  });

  it('renders rejected rule with sentence and chip', () => {
    render(<LabRecord />);
    expect(screen.getByText('Relative value, 8 hours')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Failed its re-validation on 15 October 2026. Its paper record keeps running as a public record.'
      )
    ).toBeInTheDocument();
  });

  it('renders price score with "No edge (measured)" and every V8_STATUS study name in details', () => {
    render(<LabRecord />);
    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
    expect(screen.getByText('What was measured')).toBeInTheDocument();

    for (const study of V8_STATUS.studies) {
      expect(screen.getByText(study.name)).toBeInTheDocument();
    }
  });
});
