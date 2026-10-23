import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoreHistory } from './ScoreHistory';
import { useGlobalSignals } from '@/hooks/useSignals';
import type { GlobalSignalRecord } from '@/hooks/useSignals';

vi.mock('@/hooks/useSignals', () => ({
  useGlobalSignals: vi.fn(),
}));

function generateRecords(count: number): GlobalSignalRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    _id: `sig-${i}`,
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    score: 10 + i * 2,
    tier: i % 2 === 0 ? 'buy' : 'neutral',
    confidence: 75,
    components: [],
    configVersion: 1,
    candleTimestamp: 1700000000 + i * 3600,
    expiresAt: '2026-10-23T15:00:00Z',
    createdAt: '2026-10-23T14:00:00Z',
  }));
}

describe('ScoreHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders at most 20 rows when more are provided', () => {
    const thirtyRecords = generateRecords(30);
    render(
      <ScoreHistory
        symbol="BTCUSDT"
        style="day_trading"
        interval="1h"
        signals={thirtyRecords}
      />
    );

    const rows = screen.getAllByTestId('score-history-row');
    expect(rows).toHaveLength(20);

    // Each row displays time, direction word and score
    expect(rows[0]).toHaveTextContent('Leaning up');
    expect(rows[1]).toHaveTextContent('No lean');
  });

  it('renders loading state', () => {
    vi.mocked(useGlobalSignals).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useGlobalSignals>);

    render(<ScoreHistory symbol="BTCUSDT" style="day_trading" interval="1h" />);
    expect(screen.getByText('Loading recent readings.')).toBeInTheDocument();
  });

  it('renders empty state: "No readings yet."', () => {
    vi.mocked(useGlobalSignals).mockReturnValue({
      data: { signals: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useGlobalSignals>);

    render(<ScoreHistory symbol="BTCUSDT" style="day_trading" interval="1h" />);
    expect(screen.getByText('No readings yet.')).toBeInTheDocument();
  });

  it('renders error state', () => {
    vi.mocked(useGlobalSignals).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useGlobalSignals>);

    render(<ScoreHistory symbol="BTCUSDT" style="day_trading" interval="1h" />);
    expect(screen.getByText('Could not load recent readings.')).toBeInTheDocument();
  });
});
