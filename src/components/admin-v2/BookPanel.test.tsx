import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import {
  BookPanel,
  formatChartTick,
  formatChartTooltipLabel,
} from './BookPanel';
import { describeReadRule } from '@/lib/paper-desk/report';
import type { PaperDeskBook } from '@/hooks/usePaperDesk';

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

const mockBookFixture: PaperDeskBook = {
  book: 'day_trading:1h',
  trades: 42,
  symbols: 6,
  equity: 10500.5,
  executableEquity: 10250.25,
  startEquity: 10000,
  engine: {
    trades: 42,
    expectancyPercent: 0.45,
    ciLowPercent: 0.12,
    ciHighPercent: 0.78,
    winRate: 0.552,
    totalPnl: 500.5,
  },
  executable: {
    trades: 40,
    expectancyPercent: 0.25,
    ciLowPercent: -0.05,
    ciHighPercent: 0.55,
    winRate: 0.525,
    totalPnl: 250.25,
  },
  lagCostPercent: 0.2,
  byReason: {
    stop_loss: 15,
    take_profit: 22,
    signal: 5,
  },
  gappedStops: 2,
  stoppedOnArrival: 1,
  unfilled: 2,
  missingScoreBars: 0,
  peakLeverage: 1.5,
  openPositions: 3,
  recordedExpectancyPercent: 0.35,
  evidenceStatus: 'current',
  readRule: {
    declaredOn: '2026-10-01',
    requiredTrades: 500,
    daysAtRecordedRate: 120,
    executableTrades: 40,
    futility: false,
    goLive: 'not_yet',
    executionReadReady: false,
  },
  engineCurve: [
    { bar: 0, time: 1728050400000, equity: 10000, drawdown: 0 },
    { bar: 1, time: 1728086400000, equity: 10500.5, drawdown: 0 },
  ],
  executableCurve: [
    { bar: 0, time: 1728050400000, equity: 10000, drawdown: 0 },
    { bar: 1, time: 1728086400000, equity: 10250.25, drawdown: 0 },
  ],
};

describe('BookPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders its title, both legend names and the chart text alternative with the three equities', () => {
    render(<BookPanel book={mockBookFixture} />);

    // Title
    expect(screen.getByRole('heading', { level: 2, name: 'Day trading, 1 hour' })).toBeInTheDocument();

    // Both legend names in the chart
    const chart = screen.getByTestId('equity-chart');
    expect(within(chart).getByText('Engine')).toBeInTheDocument();
    expect(within(chart).getByText('Executable')).toBeInTheDocument();

    // Text alternative stating start equity and two end equities
    const textAlt = screen.getByTestId('equity-text-alternative');
    expect(textAlt).toHaveTextContent('Starting equity: $10,000.00');
    expect(textAlt).toHaveTextContent('Engine ending equity: $10,500.50');
    expect(textAlt).toHaveTextContent('Executable ending equity: $10,250.25');
  });

  it('renders "No trades yet for this book." and no $0.00 anywhere for a zero-trade book with empty curves', () => {
    const emptyBook: PaperDeskBook = {
      ...mockBookFixture,
      trades: 0,
      engineCurve: [],
      executableCurve: [],
      engine: null,
      executable: null,
      equity: 0,
      executableEquity: 0,
      startEquity: 0,
      lagCostPercent: null,
      recordedExpectancyPercent: null,
      openPositions: 0,
      gappedStops: 0,
      stoppedOnArrival: 0,
      unfilled: 0,
      missingScoreBars: 0,
      peakLeverage: 0,
      byReason: {},
    };

    const { container } = render(<BookPanel book={emptyBook} />);

    expect(screen.getByText('No trades yet for this book.')).toBeInTheDocument();
    expect(screen.queryByTestId('equity-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('equity-text-alternative')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('$0.00');
  });

  it('uses startEquity, equity and executableEquity from BookReport in the text alternative', () => {
    const bookWithTrades: PaperDeskBook = {
      ...mockBookFixture,
      trades: 12,
      startEquity: 10000,
      equity: 12500.5,
      executableEquity: 11800.75,
      // Curves have different values to prove BookReport values are used
      engineCurve: [{ bar: 0, time: 1728050400000, equity: 9999, drawdown: 0 }],
      executableCurve: [{ bar: 0, time: 1728050400000, equity: 8888, drawdown: 0 }],
    };

    render(<BookPanel book={bookWithTrades} />);

    const textAlt = screen.getByTestId('equity-text-alternative');
    expect(textAlt).toHaveTextContent('Starting equity: $10,000.00');
    expect(textAlt).toHaveTextContent('Engine ending equity: $12,500.50');
    expect(textAlt).toHaveTextContent('Executable ending equity: $11,800.75');
    expect(textAlt).not.toHaveTextContent('9,999');
    expect(textAlt).not.toHaveTextContent('8,888');
  });

  it('shows "n/a" for zero equity values in the text alternative when trades is 0', () => {
    const bookZeroTradesWithCurve: PaperDeskBook = {
      ...mockBookFixture,
      trades: 0,
      startEquity: 10000,
      equity: 0,
      executableEquity: 0,
      engineCurve: [{ bar: 0, time: 1728050400000, equity: 10000, drawdown: 0 }],
      executableCurve: [{ bar: 0, time: 1728050400000, equity: 10000, drawdown: 0 }],
    };

    render(<BookPanel book={bookZeroTradesWithCurve} />);

    const textAlt = screen.getByTestId('equity-text-alternative');
    expect(textAlt).toHaveTextContent('Starting equity: $10,000.00');
    expect(textAlt).toHaveTextContent('Engine ending equity: n/a');
    expect(textAlt).toHaveTextContent('Executable ending equity: n/a');
  });

  it('includes "(evidence stale)" in the research line for that status', () => {
    const staleBook: PaperDeskBook = {
      ...mockBookFixture,
      recordedExpectancyPercent: -0.18,
      evidenceStatus: 'stale',
    };

    render(<BookPanel book={staleBook} />);

    const researchLine = screen.getByText(/Research expectancy at this interval:/).closest('p');
    expect(researchLine).toHaveTextContent(
      'Research expectancy at this interval: -0.18% (evidence stale)'
    );
  });

  it('renders research line with n/a and evidence status when recordedExpectancyPercent is null', () => {
    const staleNullBook: PaperDeskBook = {
      ...mockBookFixture,
      recordedExpectancyPercent: null,
      evidenceStatus: 'stale',
    };

    render(<BookPanel book={staleNullBook} />);

    const researchLine = screen.getByText(/Research expectancy at this interval:/).closest('p');
    expect(researchLine).toHaveTextContent(
      'Research expectancy at this interval: n/a (evidence stale)'
    );
  });

  it('a null executable track shows "n/a" in that column', () => {
    const bookWithNullExecutable: PaperDeskBook = {
      ...mockBookFixture,
      executable: null,
    };

    render(<BookPanel book={bookWithNullExecutable} />);

    // In the stats table, executable cells should display "n/a"
    const table = screen.getByRole('table');
    const naElements = table.querySelectorAll('td:last-child');
    expect(naElements).toHaveLength(4);
    naElements.forEach((td) => {
      expect(td).toHaveTextContent('n/a');
    });
  });

  it('lagCostPercent null shows "n/a"', () => {
    const bookWithNullLagCost: PaperDeskBook = {
      ...mockBookFixture,
      lagCostPercent: null,
    };

    render(<BookPanel book={bookWithNullLagCost} />);

    expect(screen.getByText('Lag cost per trade:')).toBeInTheDocument();
    const lagCostRow = screen.getByText('Lag cost per trade:').closest('p');
    expect(lagCostRow).toHaveTextContent('Lag cost per trade: n/a');
  });

  it('describeReadRule output appears verbatim', () => {
    render(<BookPanel book={mockBookFixture} />);

    const expectedText = describeReadRule(mockBookFixture.readRule);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: `Read rule (declared ${mockBookFixture.readRule.declaredOn})`,
      })
    ).toBeInTheDocument();
  });

  it('the details disclosure starts closed and lists byReason sorted by count', () => {
    const { container } = render(<BookPanel book={mockBookFixture} />);

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(details?.open).toBe(false);

    // List of exit reasons sorted by count: take_profit (22), stop_loss (15), signal (5)
    const exitsList = screen.getByTestId('exits-by-reason');
    const items = exitsList.querySelectorAll('li');
    expect(items).toHaveLength(3);

    expect(items[0]).toHaveTextContent('take_profit');
    expect(items[0]).toHaveTextContent('22');

    expect(items[1]).toHaveTextContent('stop_loss');
    expect(items[1]).toHaveTextContent('15');

    expect(items[2]).toHaveTextContent('signal');
    expect(items[2]).toHaveTextContent('5');
  });

  it('formats chart tick as "Oct 4" and tooltip as "Oct 4, 2026, 14:00"', () => {
    const timestamp = Date.UTC(2026, 9, 4, 14, 0); // 2026-10-04 14:00 UTC
    expect(formatChartTick(timestamp)).toBe('Oct 4');
    expect(formatChartTooltipLabel(timestamp)).toBe('Oct 4, 2026, 14:00');
  });
});
