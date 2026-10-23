import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { PaperDeskScreen } from './PaperDeskScreen';
import { usePaperDesk, type PaperDeskBook } from '@/hooks/usePaperDesk';

vi.mock('@/hooks/usePaperDesk', () => ({
  usePaperDesk: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/paper-desk',
}));

vi.mock('@/lib/chart-theme', () => ({
  useChartTheme: () => ({
    grid: '#E2E5E9',
    crosshair: '#7C8490',
    up: '#067346',
    down: '#C21F36',
    volume: '#E4E7EB',
    text: '#0F1114',
    mutedText: '#59606B',
    line: '#E2E5E9',
    accentLine: '#067346',
  }),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithSizedContainer } = await import('@/test/recharts');
  return rechartsWithSizedContainer(await importOriginal<Record<string, unknown>>());
});

const mockBook: PaperDeskBook = {
  book: 'day_trading-1h',
  trades: 10,
  symbols: 4,
  equity: 10200,
  executableEquity: 10100,
  startEquity: 10000,
  engine: {
    trades: 10,
    expectancyPercent: 0.2,
    ciLowPercent: 0.05,
    ciHighPercent: 0.35,
    winRate: 0.6,
    totalPnl: 200,
  },
  executable: {
    trades: 10,
    expectancyPercent: 0.1,
    ciLowPercent: -0.05,
    ciHighPercent: 0.25,
    winRate: 0.5,
    totalPnl: 100,
  },
  lagCostPercent: 0.1,
  byReason: { take_profit: 6, stop_loss: 4 },
  gappedStops: 0,
  stoppedOnArrival: 0,
  unfilled: 0,
  missingScoreBars: 0,
  peakLeverage: 1.0,
  openPositions: 0,
  recordedExpectancyPercent: 0.15,
  evidenceStatus: 'current',
  readRule: {
    declaredOn: '2026-10-01',
    requiredTrades: 500,
    daysAtRecordedRate: 100,
    executableTrades: 10,
    futility: false,
    goLive: 'not_yet',
    executionReadReady: false,
  },
  engineCurve: [
    { bar: 0, time: 1728050400000, equity: 10000, drawdown: 0 },
    { bar: 1, time: 1728086400000, equity: 10200, drawdown: 0 },
  ],
  executableCurve: [
    { bar: 0, time: 1728050400000, equity: 10000, drawdown: 0 },
    { bar: 1, time: 1728086400000, equity: 10100, drawdown: 0 },
  ],
};

describe('PaperDeskScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders header, description, and active admin tab', () => {
    vi.mocked(usePaperDesk).mockReturnValue({
      data: { books: [mockBook] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePaperDesk>);

    render(<PaperDeskScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Paper desk' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Paper books that trade the price score rule on live bars. Records only, no money at risk.'
      )
    ).toBeInTheDocument();

    const activeTab = screen.getByRole('link', { name: 'Paper desk' });
    expect(activeTab).toHaveAttribute('aria-current', 'page');
  });

  it('renders loading state notice when query is loading', () => {
    vi.mocked(usePaperDesk).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePaperDesk>);

    render(<PaperDeskScreen />);

    expect(screen.getByText('Loading paper desk...')).toBeInTheDocument();
    expect(screen.getByTestId('skeleton-rows')).toBeInTheDocument();
  });

  it('renders error state with "The paper desk did not load." and "Try again" calling refetch', () => {
    const refetch = vi.fn();
    vi.mocked(usePaperDesk).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Failed to load'),
      refetch,
    } as unknown as ReturnType<typeof usePaperDesk>);

    render(<PaperDeskScreen />);

    expect(screen.getByText('The paper desk did not load.')).toBeInTheDocument();
    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    expect(tryAgainBtn).toBeInTheDocument();

    fireEvent.click(tryAgainBtn);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state when there are no books', () => {
    vi.mocked(usePaperDesk).mockReturnValue({
      data: { books: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePaperDesk>);

    render(<PaperDeskScreen />);

    expect(screen.getByText('No paper books yet.')).toBeInTheDocument();
  });

  it('renders book panel when books are returned', () => {
    vi.mocked(usePaperDesk).mockReturnValue({
      data: { books: [mockBook] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePaperDesk>);

    render(<PaperDeskScreen />);

    expect(screen.getByRole('heading', { level: 2, name: 'day_trading-1h' })).toBeInTheDocument();
  });
});
