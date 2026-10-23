import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RejectedRule } from './RejectedRule';
import * as useSignalsHooks from '@/hooks/useSignals';

vi.mock('@/hooks/useSignals', () => ({
  useCrossSectionalLatest: vi.fn(),
}));

describe('RejectedRule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title, chip, and sentence when data is missing or errors', () => {
    vi.mocked(useSignalsHooks.useCrossSectionalLatest).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useSignalsHooks.useCrossSectionalLatest>);

    render(<RejectedRule />);

    expect(screen.getByText('Relative value, 8 hours')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Relative value, 8 hours' })
    ).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Rejected' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Failed its re-validation on 15 October 2026. Its paper record keeps running as a public record.'
      )
    ).toBeInTheDocument();
  });

  it('renders paper book figures when response provides them', () => {
    vi.mocked(useSignalsHooks.useCrossSectionalLatest).mockReturnValue({
      data: {
        success: true,
        signal: null,
        step: null,
        completedStep: null,
        book: {
          bookName: 'rv-v1',
          version: 'rv-v1',
          validationStatus: 'rejected',
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
          equity: {
            taker: 7800.5,
            maker: 8100.2,
          },
          peakEquity: { taker: 10000, maker: 10000 },
          alerts: { drawdownTaker: false, drawdownMaker: false, negativeStreak: 0 },
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
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSignalsHooks.useCrossSectionalLatest>);

    render(<RejectedRule />);

    expect(screen.getByText('Relative value, 8 hours')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Taker equity')).toBeInTheDocument();
    expect(screen.getByText('$7,800.50')).toBeInTheDocument();
    expect(screen.getByText('Maker equity')).toBeInTheDocument();
    expect(screen.getByText('$8,100.20')).toBeInTheDocument();
    expect(screen.getByText('Starting equity')).toBeInTheDocument();
    expect(screen.getByText('$10,000.00')).toBeInTheDocument();
  });
});
