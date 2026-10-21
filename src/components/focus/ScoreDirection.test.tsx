import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoreDirection } from './ScoreDirection';
import type { GlobalSignalRecord } from '@/hooks/useSignals';

const { mockUseGlobalSignals } = vi.hoisted(() => ({
  mockUseGlobalSignals: vi.fn(),
}));

vi.mock('@/hooks/useSignals', () => ({
  useGlobalSignals: (...args: unknown[]) => mockUseGlobalSignals(...args),
}));

describe('ScoreDirection', () => {
  const refetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    mockUseGlobalSignals.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
      refetch,
    });

    render(<ScoreDirection symbol="BTCUSDT" interval="15m" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading signal scores...');
    expect(screen.getByText('Signal score (v8)')).toBeInTheDocument();
    expect(screen.getByText('Measured: no edge')).toBeInTheDocument();
  });

  it('renders error state and retries on click', () => {
    mockUseGlobalSignals.mockReturnValue({
      isLoading: false,
      error: new Error('Failed to load signal scores'),
      data: undefined,
      refetch,
    });

    render(<ScoreDirection symbol="BTCUSDT" interval="15m" />);

    expect(
      screen.getByText('Could not load signal scores: Failed to load signal scores.')
    ).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toHaveClass('min-h-11');
    fireEvent.click(retryBtn);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state when no signals are found', () => {
    mockUseGlobalSignals.mockReturnValue({
      isLoading: false,
      error: null,
      data: { signals: [] },
      refetch,
    });

    render(<ScoreDirection symbol="BTCUSDT" interval="15m" />);

    expect(
      screen.getByText('No stored score for this coin and interval yet.')
    ).toBeInTheDocument();
  });

  it('renders data without arrows when there is no previous row', () => {
    const latestSignal: Partial<GlobalSignalRecord> = {
      score: 45.2,
      tier: 'buy',
      components: [
        { category: 'trend', score: 30, weight: 0.225, weightedScore: 6.75, signals: [] },
        { category: 'momentum', score: 20, weight: 0.225, weightedScore: 4.5, signals: [] },
        { category: 'volume', score: 10, weight: 0.135, weightedScore: 1.35, signals: [] },
        { category: 'volatility', score: 0, weight: 0.09, weightedScore: 0, signals: [] },
        { category: 'futures', score: -10, weight: 0.135, weightedScore: -1.35, signals: [] },
        { category: 'sentiment', score: -20, weight: 0.09, weightedScore: -1.8, signals: [] },
        { category: 'htf', score: 5, weight: 0.10, weightedScore: 0.5, signals: [] },
      ],
    };

    mockUseGlobalSignals.mockReturnValue({
      isLoading: false,
      error: null,
      data: { signals: [latestSignal] },
      refetch,
    });

    render(<ScoreDirection symbol="BTCUSDT" interval="15m" />);

    // Total score and tier
    expect(screen.getByText('+45')).toBeInTheDocument();
    expect(screen.getByText('Long score')).toBeInTheDocument();

    // Check categories and scores
    const trendRow = screen.getByTestId('score-category-trend');
    expect(trendRow).toHaveTextContent('Trend');
    expect(trendRow).toHaveTextContent('+30');

    const futuresRow = screen.getByTestId('score-category-futures');
    expect(futuresRow).toHaveTextContent('Futures');
    expect(futuresRow).toHaveTextContent('-10');

    // No arrows should be rendered
    expect(screen.queryByLabelText(/previous bar/)).not.toBeInTheDocument();
  });

  it('renders comparison arrows (higher, lower, equal) when previous row is present', () => {
    const latestSignal: Partial<GlobalSignalRecord> = {
      score: 50,
      tier: 'strong_buy',
      components: [
        { category: 'trend', score: 40, weight: 0.225, weightedScore: 9, signals: [] }, // higher than 30 (▲)
        { category: 'momentum', score: 10, weight: 0.225, weightedScore: 2.25, signals: [] }, // lower than 20 (▼)
        { category: 'volume', score: 15, weight: 0.135, weightedScore: 2.025, signals: [] }, // equal to 15 (=)
        { category: 'volatility', score: 0, weight: 0.09, weightedScore: 0, signals: [] },
        { category: 'futures', score: 0, weight: 0.135, weightedScore: 0, signals: [] },
        { category: 'sentiment', score: 0, weight: 0.09, weightedScore: 0, signals: [] },
        { category: 'htf', score: 0, weight: 0.10, weightedScore: 0, signals: [] },
      ],
    };

    const previousSignal: Partial<GlobalSignalRecord> = {
      score: 40,
      tier: 'buy',
      components: [
        { category: 'trend', score: 30, weight: 0.225, weightedScore: 6.75, signals: [] },
        { category: 'momentum', score: 20, weight: 0.225, weightedScore: 4.5, signals: [] },
        { category: 'volume', score: 15, weight: 0.135, weightedScore: 2.025, signals: [] },
        { category: 'volatility', score: 0, weight: 0.09, weightedScore: 0, signals: [] },
        { category: 'futures', score: 0, weight: 0.135, weightedScore: 0, signals: [] },
        { category: 'sentiment', score: 0, weight: 0.09, weightedScore: 0, signals: [] },
        { category: 'htf', score: 0, weight: 0.10, weightedScore: 0, signals: [] },
      ],
    };

    mockUseGlobalSignals.mockReturnValue({
      isLoading: false,
      error: null,
      data: { signals: [latestSignal, previousSignal] },
      refetch,
    });

    render(<ScoreDirection symbol="BTCUSDT" interval="1h" />);

    // Check hook arguments
    expect(mockUseGlobalSignals).toHaveBeenCalledWith(
      'BTCUSDT',
      'day_trading',
      '1h',
      2
    );

    // Trend has ▲
    const trendRow = screen.getByTestId('score-category-trend');
    expect(trendRow).toHaveTextContent('▲');
    expect(within(trendRow).getByLabelText('higher than the previous bar')).toBeInTheDocument();

    // Momentum has ▼
    const momentumRow = screen.getByTestId('score-category-momentum');
    expect(momentumRow).toHaveTextContent('▼');
    expect(within(momentumRow).getByLabelText('lower than the previous bar')).toBeInTheDocument();

    // Volume has =
    const volumeRow = screen.getByTestId('score-category-volume');
    expect(volumeRow).toHaveTextContent('=');
    expect(within(volumeRow).getByLabelText('equal to the previous bar')).toBeInTheDocument();
  });
});
