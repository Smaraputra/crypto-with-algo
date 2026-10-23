import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoreReading, directionInWords } from './ScoreReading';
import { useLatestSignalForStyle } from '@/hooks/useSignals';
import type { SignalTier } from '@/types/signal';
import type { GlobalSignalRecord } from '@/hooks/useSignals';

vi.mock('@/hooks/useSignals', () => ({
  useLatestSignalForStyle: vi.fn(),
}));

function makeSignal(tier: SignalTier, score = 42.5): GlobalSignalRecord {
  return {
    _id: 'sig-test',
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    score,
    tier,
    confidence: 80,
    components: [],
    configVersion: 1,
    candleTimestamp: 1700000000,
    expiresAt: '2026-10-23T15:00:00Z',
    createdAt: '2026-10-23T14:00:00Z',
  };
}

describe('ScoreReading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tier mapping', () => {
    it('maps each tier to its direction words', () => {
      expect(directionInWords('strong_buy')).toBe('Strongly leaning up');
      expect(directionInWords('buy')).toBe('Leaning up');
      expect(directionInWords('neutral')).toBe('No lean');
      expect(directionInWords('sell')).toBe('Leaning down');
      expect(directionInWords('strong_sell')).toBe('Strongly leaning down');
    });

    const tiers: SignalTier[] = [
      'strong_buy',
      'buy',
      'neutral',
      'sell',
      'strong_sell',
    ];

    for (const tier of tiers) {
      it(`renders the direction words for tier ${tier}`, () => {
        const signal = makeSignal(tier);
        const { container } = render(
          <ScoreReading symbol="BTCUSDT" style="day_trading" interval="1h" signal={signal} />
        );

        const expectedText = directionInWords(tier);
        expect(screen.getByText(expectedText)).toBeInTheDocument();
        expect(container.textContent).not.toMatch(/entry|stop|target|size|leverage|\bbuy\b|\bsell\b/i);
      });
    }
  });

  it('renders the chip and the muted line', () => {
    const signal = makeSignal('buy');
    render(<ScoreReading symbol="BTCUSDT" style="day_trading" interval="1h" signal={signal} />);

    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This reading is context only. The rule built on it lost after costs at every interval measured.'
      )
    ).toBeInTheDocument();
  });

  it('renders score details line correctly', () => {
    const signal = makeSignal('neutral', 12.3);
    render(<ScoreReading symbol="BTCUSDT" style="day_trading" interval="1h" signal={signal} />);

    expect(screen.getByText(/Score 12\.3 on 1h, Day trading\. Bar closed/)).toBeInTheDocument();
  });

  describe('states', () => {
    it('renders loading state: "Loading the score."', () => {
      vi.mocked(useLatestSignalForStyle).mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useLatestSignalForStyle>);

      const { container } = render(<ScoreReading symbol="BTCUSDT" style="day_trading" interval="1h" />);

      expect(screen.getByText('Loading the score.')).toBeInTheDocument();
      expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
      expect(
        screen.getByText(
          'This reading is context only. The rule built on it lost after costs at every interval measured.'
        )
      ).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/entry|stop|target|size|leverage|\bbuy\b|\bsell\b/i);
    });

    it('renders none/empty state: "No score for this coin and interval yet."', () => {
      vi.mocked(useLatestSignalForStyle).mockReturnValue({
        data: { signal: null },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useLatestSignalForStyle>);

      const { container } = render(<ScoreReading symbol="BTCUSDT" style="day_trading" interval="1h" />);

      expect(screen.getByText('No score for this coin and interval yet.')).toBeInTheDocument();
      expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
      expect(
        screen.getByText(
          'This reading is context only. The rule built on it lost after costs at every interval measured.'
        )
      ).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/entry|stop|target|size|leverage|\bbuy\b|\bsell\b/i);
    });

    it('renders error state: "The score did not load." with "Try again" button', () => {
      const refetch = vi.fn();
      vi.mocked(useLatestSignalForStyle).mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        refetch,
      } as unknown as ReturnType<typeof useLatestSignalForStyle>);

      const { container } = render(<ScoreReading symbol="BTCUSDT" style="day_trading" interval="1h" />);

      expect(screen.getByText('The score did not load.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
      expect(
        screen.getByText(
          'This reading is context only. The rule built on it lost after costs at every interval measured.'
        )
      ).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/entry|stop|target|size|leverage|\bbuy\b|\bsell\b/i);
    });
  });
});
