import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamStatus } from '@/lib/market-stream/client';
import type { BarArrival } from '@/hooks/useBarArrivalLag';
import type { PriorDayLevels } from '@/lib/market/levels';
import type { LabResponse } from '@/lib/signals/lab/view';
import type { CrossSectionalLatestResponse } from '@/hooks/useSignals';
import {
  WhenToLookPanel,
  nextLabBarAt,
  lookReasons,
} from './WhenToLookPanel';

const mockRetry = vi.fn();
let mockMarketStatus: {
  status: StreamStatus;
  lastMessageAt: number | null;
  isConnected: boolean;
  retry: () => void;
} = {
  status: 'live',
  lastMessageAt: 1_700_000_000_000,
  isConnected: true,
  retry: mockRetry,
};

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: () => mockMarketStatus,
}));

let mockArrival: BarArrival | null = null;
vi.mock('@/hooks/useBarArrivalLag', () => ({
  useBarArrivalLag: () => mockArrival,
}));

let mockWatchlistData: { symbols: string[]; isLoading: boolean } = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  isLoading: false,
};
vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => mockWatchlistData,
}));

let mockTickers: Record<string, { lastPrice: string }> = {};
vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: () => ({ tickers: mockTickers }),
}));

let mockLevelsData:
  | {
      asOf: string;
      levels: Record<string, PriorDayLevels | null>;
    }
  | undefined = undefined;
let mockLevelsLoading = false;
let mockLevelsError = false;

vi.mock('@/hooks/useDailyLevels', () => ({
  useDailyLevels: () => ({
    data: mockLevelsData,
    isLoading: mockLevelsLoading,
    isError: mockLevelsError,
  }),
}));

const mockRefetchLab = vi.fn();
let mockLabData: LabResponse | undefined = undefined;
let mockLabLoading = false;
let mockLabError = false;

vi.mock('@/hooks/useSignalLab', () => ({
  useSignalLab: () => ({
    data: mockLabData,
    isLoading: mockLabLoading,
    isError: mockLabError,
    refetch: mockRefetchLab,
  }),
}));

let mockCrossData: CrossSectionalLatestResponse | undefined = undefined;
let mockCrossLoading = false;
let mockCrossError = false;

vi.mock('@/hooks/useSignals', () => ({
  useCrossSectionalLatest: () => ({
    data: mockCrossData,
    isLoading: mockCrossLoading,
    isError: mockCrossError,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockMarketStatus = {
    status: 'live',
    lastMessageAt: 1_700_000_000_000,
    isConnected: true,
    retry: mockRetry,
  };
  mockArrival = null;
  mockWatchlistData = { symbols: ['BTCUSDT', 'ETHUSDT'], isLoading: false };
  mockTickers = {};
  mockLevelsData = undefined;
  mockLevelsLoading = false;
  mockLevelsError = false;
  mockLabData = {
    version: 'lab-v1',
    threshold: 10,
    hypotheses: [
      {
        id: 'L1-1h',
        candidate: 'L1',
        timeframe: '1h',
        status: 'under_test',
        underTestSince: '2026-01-01T00:00:00Z',
        testEndsAt: '2028-01-01T00:00:00Z',
        validatedAt: null,
        gradedBars: 100,
        betBars: 20,
        e: 3.5,
        e0: 0,
        threshold: 10,
        meanX: 0.1,
        meanB: 0.05,
        currentB: 0.02,
        latestBar: null,
      },
    ],
  };
  mockLabLoading = false;
  mockLabError = false;
  mockCrossData = undefined;
  mockCrossLoading = false;
  mockCrossError = false;
});

describe('nextLabBarAt', () => {
  it('nextLabBarAt(Date.UTC(2026,9,18,15,0)) is Date.UTC(2026,9,18,16,3)', () => {
    expect(nextLabBarAt(Date.UTC(2026, 9, 18, 15, 0))).toBe(
      Date.UTC(2026, 9, 18, 16, 3)
    );
  });

  it('at 16:03 exactly it is 00:03 the next day', () => {
    expect(nextLabBarAt(Date.UTC(2026, 9, 18, 16, 3))).toBe(
      Date.UTC(2026, 9, 19, 0, 3)
    );
  });

  it('at 23:59 it is 00:03 the next day', () => {
    expect(nextLabBarAt(Date.UTC(2026, 9, 18, 23, 59))).toBe(
      Date.UTC(2026, 9, 19, 0, 3)
    );
  });
});

describe('lookReasons', () => {
  it('gives [] with status live, no near coins and no validated hypotheses', () => {
    const reasons = lookReasons({
      status: 'live',
      nearCoins: [],
      validatedHypothesisIds: [],
    });
    expect(reasons).toEqual([]);
  });

  it("gives ['prices are stale'] with status stale", () => {
    const reasons = lookReasons({
      status: 'stale',
      nearCoins: [],
      validatedHypothesisIds: [],
    });
    expect(reasons).toEqual(['prices are stale']);
  });

  it('with one near coin it adds the coin sentence', () => {
    const reasons = lookReasons({
      status: 'live',
      nearCoins: [
        {
          symbol: 'BTCUSDT',
          distanceAtr: -0.3,
          level: 'high',
        },
      ],
      validatedHypothesisIds: [],
    });
    expect(reasons).toEqual(['BTC is 0.3 ATR below the prev high']);
  });
});

describe('WhenToLookPanel rendering', () => {
  it('live with nothing near: the headline reads "Nothing needs a look right now."', () => {
    render(<WhenToLookPanel />);
    const headline = screen.getByTestId('look-headline');
    expect(headline).toHaveTextContent('Nothing needs a look right now.');
    expect(headline).not.toHaveClass('text-accent');
    expect(headline).toHaveClass('text-muted-foreground');
  });

  it('stale: the headline has the class text-accent and contains prices are stale, and a Reconnect live prices button calls retry', () => {
    mockMarketStatus = {
      ...mockMarketStatus,
      status: 'stale',
    };
    render(<WhenToLookPanel />);
    const headline = screen.getByTestId('look-headline');
    expect(headline).toHaveClass('text-accent');
    expect(headline).toHaveTextContent('prices are stale');

    const retryBtn = screen.getByRole('button', { name: 'Reconnect live prices' });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('lab loading: the text Loading the forward lab.', () => {
    mockLabLoading = true;
    render(<WhenToLookPanel />);
    expect(screen.getByText('Loading the forward lab.')).toBeInTheDocument();
  });

  it('lab error: Could not load the forward lab., and its Retry forward lab button calls refetch', () => {
    mockLabError = true;
    render(<WhenToLookPanel />);
    expect(screen.getByText('Could not load the forward lab.')).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: 'Retry forward lab' });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(mockRefetchLab).toHaveBeenCalledTimes(1);
  });

  it('rv-v1 rejected: the text contains rejected by re-validation', () => {
    mockCrossData = {
      book: {
        validationStatus: 'rejected',
      },
    } as unknown as CrossSectionalLatestResponse;
    render(<WhenToLookPanel />);
    expect(screen.getByText(/rejected by re-validation/)).toBeInTheDocument();
  });

  it('empty watchlist: the add-coins sentence', () => {
    mockWatchlistData = { symbols: [], isLoading: false };
    render(<WhenToLookPanel />);
    expect(
      screen.getByText(
        "Add coins to the watchlist to see their distance to yesterday's levels."
      )
    ).toBeInTheDocument();
  });

  it('watchlist loading: the loading sentence', () => {
    mockWatchlistData = { symbols: [], isLoading: true };
    render(<WhenToLookPanel />);
    expect(screen.getByText('Loading the watchlist.')).toBeInTheDocument();
  });
});
