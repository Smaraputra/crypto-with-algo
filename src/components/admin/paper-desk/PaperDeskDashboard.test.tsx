import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

const mockUsePaperDesk = vi.fn();
vi.mock('@/hooks/usePaperDesk', () => ({ usePaperDesk: () => mockUsePaperDesk() }));
vi.mock('@/components/backtest/EquityCurveChart', () => ({
  EquityCurveChart: () => <div data-testid="equity-chart" />,
}));

import { PaperDeskDashboard } from './PaperDeskDashboard';

function book(over: Record<string, unknown> = {}) {
  return {
    book: 'day_trading:1h',
    trades: 12,
    symbols: 10,
    equity: 9980,
    executableEquity: 9950,
    startEquity: 10000,
    engine: {
      trades: 12,
      expectancyPercent: -0.0421,
      ciLowPercent: -0.15,
      ciHighPercent: 0.06,
      winRate: 0.4167,
      totalPnl: -20,
    },
    executable: {
      trades: 12,
      expectancyPercent: -0.0812,
      ciLowPercent: -0.2,
      ciHighPercent: 0.03,
      winRate: 0.4167,
      totalPnl: -50,
    },
    lagCostPercent: 0.0391,
    byReason: { signal: 8, stop_loss: 3, take_profit: 1 },
    gappedStops: 1,
    stoppedOnArrival: 0,
    unfilled: 0,
    missingScoreBars: 4,
    peakLeverage: 2.37,
    openPositions: 2,
    recordedExpectancyPercent: -0.0687,
    evidenceStatus: 'current',
    readRule: {
      declaredOn: '2026-10-02',
      requiredTrades: 61_000,
      daysAtRecordedRate: null,
      executableTrades: 12,
      futility: false,
      goLive: 'not_yet',
      executionReadReady: false,
    },
    engineCurve: [{ bar: 0, time: 1, equity: 9990, drawdown: 0.1 }],
    executableCurve: [{ bar: 0, time: 1, equity: 9980, drawdown: 0.2 }],
    ...over,
  };
}

describe('PaperDeskDashboard', () => {
  it('shows a loading state', () => {
    mockUsePaperDesk.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<PaperDeskDashboard />);
    expect(screen.getByTestId('paper-desk-loading')).toBeInTheDocument();
  });

  it('shows an error state', () => {
    mockUsePaperDesk.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<PaperDeskDashboard />);
    expect(screen.getByText(/record is unavailable/)).toBeInTheDocument();
  });

  it('shows both tracks, the lag cost and the recorded number for a book', () => {
    mockUsePaperDesk.mockReturnValue({ data: { books: [book()] }, isLoading: false, isError: false });
    render(<PaperDeskDashboard />);

    const panel = screen.getByTestId('paper-desk-book-day_trading:1h');
    expect(panel).toHaveTextContent('12 closed, 2 open, 10 ledgers');
    expect(panel).toHaveTextContent('-0.0421%');
    expect(panel).toHaveTextContent('-0.0812%');
    expect(panel).toHaveTextContent('+0.0391%');
    expect(panel).toHaveTextContent('-0.0687%');
    expect(panel).toHaveTextContent('41.7%');
    expect(panel).toHaveTextContent('2.37x');
    expect(panel).toHaveTextContent('signal 8, stop_loss 3, take_profit 1');
    expect(panel).toHaveTextContent('1 gapped stops');
    expect(screen.getByTestId('equity-chart')).toBeInTheDocument();
  });

  it('says so for a book with no closed trades, and draws no chart', () => {
    mockUsePaperDesk.mockReturnValue({
      data: { books: [book({ trades: 0, engine: null, executable: null, lagCostPercent: null })] },
      isLoading: false,
      isError: false,
    });
    render(<PaperDeskDashboard />);
    expect(screen.getByTestId('paper-desk-book-day_trading:1h')).toHaveTextContent('No closed trades yet');
    expect(screen.queryByTestId('equity-chart')).not.toBeInTheDocument();
  });

  it('renders one panel per book, never pooled', () => {
    mockUsePaperDesk.mockReturnValue({
      data: { books: [book(), book({ book: 'day_trading:15m' })] },
      isLoading: false,
      isError: false,
    });
    render(<PaperDeskDashboard />);
    expect(screen.getByTestId('paper-desk-book-day_trading:1h')).toBeInTheDocument();
    expect(screen.getByTestId('paper-desk-book-day_trading:15m')).toBeInTheDocument();
  });

  it('shows the pre-declared read rule on every book, closed trades or not', () => {
    mockUsePaperDesk.mockReturnValue({
      data: {
        books: [
          book(),
          book({
            book: 'day_trading:15m',
            trades: 0,
            readRule: { ...book().readRule, futility: true },
          }),
        ],
      },
      isLoading: false,
      isError: false,
    });
    render(<PaperDeskDashboard />);
    expect(screen.getByTestId('paper-desk-read-rule-day_trading:1h')).toHaveTextContent(
      'Needs 61,000 executable trades. Go-live not yet read, 12 so far.'
    );
    const closed = screen.getByTestId('paper-desk-read-rule-day_trading:15m');
    expect(closed).toHaveTextContent('FUTILITY');
    expect(closed).toHaveClass('text-bearish');
  });
});
