import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoreTrackRecord } from './ScoreTrackRecord';
import * as useTrackRecordModule from '@/hooks/useTrackRecord';
import type { TrackRecordResponse } from '@/lib/signals/track-record/types';

vi.mock('@/hooks/useTrackRecord', () => ({
  useTrackRecord: vi.fn(),
  isTrackRecordEligible: vi.fn(() => true),
}));

const mockRealisticData: TrackRecordResponse = {
  available: true,
  run: {
    runId: 'v8-rescore-2026-10-10',
    configVersion: 8,
    windowStart: '2025-10-01T00:00:00Z',
    windowEnd: '2026-10-01T00:00:00Z',
    cutoffs: { buy: 2, strong: 4 },
    rowsSha256: 'abc',
    reportSha256: 'def',
    gitCommit: '1234567',
    resamples: 1000,
    seed: 42,
    loadedAt: '2026-10-10T00:00:00Z',
  },
  cell: {
    style: 'day_trading',
    interval: '1h',
    horizonBars: 24,
    costPercent: 0.16,
    pooled: {
      rows: 15000,
      buyN: 7500,
      sellN: 7500,
      bh: 0.485,
      bhLo: 0.461,
      bhHi: 0.509,
      net: -0.12,
      netLo: -0.25,
      netHi: 0.01,
      spearman: 0.02,
      level: 0.05,
      verdict: 'No edge after costs',
    },
    parity: {
      matched: 15000,
      sameTierShare: 0.95,
      scoreCorrelation: 0.98,
    },
  },
  symbol: {
    symbol: 'BTCUSDT',
    first: 1727740800000, // 1 Oct 2024 UTC
    last: 1759276800000, // 1 Oct 2025 UTC
    liveSince: 1759276800000,
    measures: {
      calls: 1520,
      buyN: 760,
      sellN: 760,
      buyHit: 0.44,
      sellHit: 0.448,
      bh: 0.444,
      right: 0.444,
      meanBefore: -0.08,
      net: -0.24,
      wonAfterCost: 0.42,
      avgWin: 1.2,
      avgLoss: 1.1,
      breakEven: 0.518,
    },
    intervals: {
      right: { lo: 0.41, hi: 0.48 },
      bh: { lo: 0.41, hi: 0.48 },
      net: { lo: -0.54, hi: 0.04 },
    },
    months: [],
  },
  live: {
    since: 1759276800000,
    resolved: 42,
    pending: 3,
    measures: {
      calls: 42,
      buyN: 18,
      sellN: 24,
      buyHit: 0.45,
      sellHit: 0.55,
      bh: 0.50,
      right: 0.524,
      meanBefore: 0.01,
      net: -0.15,
      wonAfterCost: 0.45,
      avgWin: 1.1,
      avgLoss: 1.0,
      breakEven: 0.52,
    },
  },
  boundary: 1759276800000,
  liveConfigVersion: 8,
};

describe('ScoreTrackRecord', () => {
  const mockRefetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: mockRealisticData,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);
  });

  it('the headline sentence shows "Right 44.4%", "50%" and "51.8%"', () => {
    render(<ScoreTrackRecord />);
    expect(screen.getByText(/Right 44\.4% of the time/)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/Breaking even after 0\.16% costs needed about 51\.8%\./)).toBeInTheDocument();
  });

  it('omits break-even sentence when breakEven is null', () => {
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: {
        ...mockRealisticData,
        symbol: {
          ...mockRealisticData.symbol!,
          measures: {
            ...mockRealisticData.symbol!.measures,
            breakEven: null,
          },
        },
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    render(<ScoreTrackRecord />);
    expect(screen.getByText(/Right 44\.4% of the time\. A coin flip is right 50%\./)).toBeInTheDocument();
    expect(screen.queryByText(/Breaking even after/)).not.toBeInTheDocument();
  });

  it('the ruler text alternative contains all four values', () => {
    render(<ScoreTrackRecord />);
    const ruler = screen.getByRole('img', { name: /Balanced hit rate 44\.4%/i });
    expect(ruler).toBeInTheDocument();

    const ariaLabel = ruler.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('44.4%');
    expect(ariaLabel).toContain('50%');
    expect(ariaLabel).toContain('51.8%');
    expect(ariaLabel).toContain('41.0% to 48.0%');
  });

  it('the net line is signed and has the down colour class', () => {
    render(<ScoreTrackRecord />);
    const netLine = screen.getByText(/Acting on every call returned/).closest('p');
    expect(netLine).not.toBeNull();
    expect(netLine).toHaveClass('text-down');
    expect(netLine).toHaveTextContent('-0.24%');
    expect(netLine).toHaveTextContent('-0.54% to +0.04%');
  });

  it('the net line has text-up when net is positive', () => {
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: {
        ...mockRealisticData,
        symbol: {
          ...mockRealisticData.symbol!,
          measures: {
            ...mockRealisticData.symbol!.measures,
            net: 0.35,
          },
        },
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    render(<ScoreTrackRecord />);
    const netLine = screen.getByText(/Acting on every call returned/).closest('p');
    expect(netLine).toHaveClass('text-up');
    expect(netLine).toHaveTextContent('+0.35%');
  });

  it('changing the coin select and the timeframe calls the hook with the new symbol, interval and style', () => {
    render(<ScoreTrackRecord />);
    expect(useTrackRecordModule.useTrackRecord).toHaveBeenCalledWith('BTCUSDT', '1h', 'day_trading');

    const select = screen.getByRole('combobox', { name: 'Coin' });
    fireEvent.change(select, { target: { value: 'ETHUSDT' } });
    expect(useTrackRecordModule.useTrackRecord).toHaveBeenCalledWith('ETHUSDT', '1h', 'day_trading');

    const fourHoursRadio = screen.getByLabelText('4 hours');
    fireEvent.click(fourHoursRadio);
    expect(useTrackRecordModule.useTrackRecord).toHaveBeenCalledWith('ETHUSDT', '4h', 'swing_trading');
  });

  it('the loading, error (refetch called), unavailable and no-rows states render', () => {
    // Loading
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    const { rerender } = render(<ScoreTrackRecord />);
    expect(screen.getByText('Loading the track record.')).toBeInTheDocument();

    // Error
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    rerender(<ScoreTrackRecord />);
    expect(screen.getByText('The track record did not load.')).toBeInTheDocument();
    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(tryAgainBtn);
    expect(mockRefetch).toHaveBeenCalledTimes(1);

    // Unavailable (available: false)
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: { available: false, reason: 'not-scored' },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    rerender(<ScoreTrackRecord />);
    expect(screen.getByText('No track record for this coin and timeframe.')).toBeInTheDocument();

    // No rows (symbol is null)
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: {
        ...mockRealisticData,
        symbol: null,
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    rerender(<ScoreTrackRecord />);
    expect(screen.getByText('No track record for this coin and timeframe.')).toBeInTheDocument();
  });

  it('the live line shows "Too few to judge yet" when buyN is 18 and sellN is 24, and omits it when both are 30 or more', () => {
    // buyN 18, sellN 24
    const { rerender } = render(<ScoreTrackRecord />);
    expect(
      screen.getByText(/Too few to judge yet: the research needs 30 calls on each side\./)
    ).toBeInTheDocument();

    // buyN 30, sellN 35
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: {
        ...mockRealisticData,
        live: {
          ...mockRealisticData.live,
          measures: {
            ...mockRealisticData.live.measures,
            buyN: 30,
            sellN: 35,
          },
        },
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    rerender(<ScoreTrackRecord />);
    expect(screen.getByText(/Live since 1 Oct 2025/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Too few to judge yet: the research needs 30 calls on each side\./)
    ).not.toBeInTheDocument();
  });

  it('omits live line when live.since is null', () => {
    vi.mocked(useTrackRecordModule.useTrackRecord).mockReturnValue({
      data: {
        ...mockRealisticData,
        live: {
          ...mockRealisticData.live,
          since: null,
        },
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useTrackRecordModule.useTrackRecord>);

    render(<ScoreTrackRecord />);
    expect(screen.queryByText(/Live since/)).not.toBeInTheDocument();
  });

  it('renders the calls line and pooled line correctly', () => {
    render(<ScoreTrackRecord />);
    expect(screen.getByText(/1,520 calls from 1 Oct 2024 to 1 Oct 2025\./)).toBeInTheDocument();
    expect(
      screen.getByText(/All ten coins, same timeframe: no edge after costs\. Right 48\.5% \(46\.1% to 50\.9%\)\./)
    ).toBeInTheDocument();
  });

  it('no text matches /stop|target|size|leverage/i', () => {
    const { container } = render(<ScoreTrackRecord />);
    const textContent = container.textContent ?? '';
    expect(textContent).not.toMatch(/stop|target|size|leverage/i);

    const elementsWithAria = container.querySelectorAll('[aria-label]');
    for (const el of elementsWithAria) {
      expect(el.getAttribute('aria-label') ?? '').not.toMatch(/stop|target|size|leverage/i);
    }
  });
});
