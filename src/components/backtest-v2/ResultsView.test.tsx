import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { ResultsView } from './ResultsView';
import { useSaveBacktestResult } from '@/hooks/useBacktestResults';
import type { BacktestResult } from '@/lib/backtest/types';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import { saveBacktestResultSchema } from '@/types/backtest';

vi.mock('@/hooks/useBacktestResults', () => ({
  useSaveBacktestResult: vi.fn(),
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

let capturedXAxisProps: Record<string, unknown> | null = null;

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithSizedContainer } = await import('@/test/recharts');
  const actual = await importOriginal<Record<string, unknown>>();
  const base = rechartsWithSizedContainer(actual);
  const ActualXAxis = actual.XAxis as React.ComponentType<Record<string, unknown>>;
  const XAxis = (props: Record<string, unknown>) => {
    capturedXAxisProps = props;
    return <ActualXAxis {...props} />;
  };
  XAxis.displayName = 'XAxis';
  return {
    ...base,
    XAxis,
  };
});

const mockResultFixture: BacktestResult = {
  symbol: 'BTCUSDT',
  interval: '1h',
  config: DEFAULT_BACKTEST_CONFIG,
  startTime: 1704067200000,
  endTime: 1719792000000,
  totalBars: 4320,
  warmupBars: 200,
  metrics: {
    totalPnl: 1450.5,
    totalPnlPercent: 14.51,
    totalTrades: 32,
    winningTrades: 18,
    losingTrades: 14,
    winRate: 0.5625,
    profitFactor: 1.48,
    maxDrawdown: 620.0,
    maxDrawdownPercent: 5.8,
    sharpeRatio: 1.35,
    sortinoRatio: 1.82,
    calmarRatio: 2.5,
    avgWin: 120.5,
    avgLoss: 65.2,
    avgWinPercent: 1.2,
    avgLossPercent: 0.65,
    totalFees: 48.25,
    maxConsecutiveWins: 4,
    maxConsecutiveLosses: 3,
    expectancyPercent: 0.45,
    expectancyR: 0.32,
    sessionBreakdown: [
      {
        session: 'ny_overlap',
        trades: 12,
        wins: 8,
        winRate: 0.667,
        totalPnl: 850.2,
        avgPnlPercent: 0.85,
      },
    ],
  },
  equityCurve: [
    { bar: 0, time: 1704067200000, equity: 10000, drawdown: 0 },
    { bar: 2000, time: 1712000000000, equity: 10800, drawdown: 100 },
    { bar: 4320, time: 1719792000000, equity: 11450.5, drawdown: 0 },
  ],
  trades: [
    {
      entryBar: 100,
      exitBar: 120,
      entryTime: 1704427200000,
      exitTime: 1704499200000,
      side: 'long',
      entryPrice: 42000,
      exitPrice: 43200,
      quantity: 0.25,
      pnl: 300,
      pnlPercent: 2.86,
      fees: 4.2,
      exitReason: 'take_profit',
      exitScore: 25,
      holdTimeBars: 20,
      riskPercent: 2.0,
      rewardPercent: 4.0,
      slippageCost: 0,
      entryFillKind: 'taker',
      exitFillKind: 'taker',
      fundingCost: 0,
    },
  ],
};

describe('ResultsView', () => {
  const mockMutateSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    capturedXAxisProps = null;

    vi.mocked(useSaveBacktestResult).mockReturnValue({
      mutate: mockMutateSave,
      isPending: false,
    } as unknown as ReturnType<typeof useSaveBacktestResult>);
  });

  it('Metrics render from a fixture with signs and labels, and the equity chart text alternative is present', () => {
    render(
      <ResultsView
        result={mockResultFixture}
        selectedStrategyId="strat-123"
      />
    );

    // Total P&L
    const totalPnlElement = screen.getByTestId('metric-total-pnl');
    expect(totalPnlElement).toHaveTextContent('+$1,450.50 (+14.51%)');
    expect(totalPnlElement).toHaveClass('text-up');

    // Win rate
    expect(screen.getByTestId('metric-win-rate')).toHaveTextContent('56.3%');

    // Profit factor & Sharpe with plain labels and meanings
    expect(screen.getByTestId('metric-profit-factor')).toHaveTextContent('1.48');
    expect(screen.getByText('Gross profits divided by gross losses')).toBeInTheDocument();

    expect(screen.getByTestId('metric-sharpe')).toHaveTextContent('1.35');
    expect(
      screen.getByText('Return per unit of volatility, annualised. No risk-free rate is subtracted.')
    ).toBeInTheDocument();
    expect(screen.getByText(/No risk-free rate is subtracted/)).toBeInTheDocument();

    // Expectancy
    const expectancyElement = screen.getByTestId('metric-expectancy');
    expect(expectancyElement).toHaveTextContent('+0.45%');

    // Max drawdown
    expect(screen.getByTestId('metric-max-drawdown')).toHaveTextContent('5.8%');

    // Total fees & trades
    expect(screen.getByTestId('metric-total-fees')).toHaveTextContent('$48.25');
    expect(screen.getByTestId('metric-total-trades')).toHaveTextContent('32');

    // Equity curve text alternative
    const textAlternative = screen.getByTestId('equity-text-alternative');
    expect(textAlternative).toHaveTextContent('Starting equity: $10,000.00, ending equity: $11,450.50');

    // Session breakdown table
    expect(screen.getByText('London/NY Overlap')).toBeInTheDocument();
    expect(screen.getByText('66.7%')).toBeInTheDocument();

    // Trades table
    expect(screen.getByText('Take profit')).toBeInTheDocument();
    expect(screen.getByText('+$300.00 (+2.86%)')).toBeInTheDocument();
    expect(screen.getByText('Long')).toBeInTheDocument();
  });

  it('Saving a result sends a schema-valid payload', () => {
    render(
      <ResultsView
        result={mockResultFixture}
        selectedStrategyId="strat-123"
      />
    );

    const saveButton = screen.getByRole('button', { name: 'Save this result' });
    fireEvent.click(saveButton);

    expect(mockMutateSave).toHaveBeenCalledTimes(1);
    const payload = mockMutateSave.mock.calls[0][0];

    // Validate payload against schema
    const parseResult = saveBacktestResultSchema.safeParse(payload);
    expect(parseResult.success).toBe(true);

    expect(payload.strategyId).toBe('strat-123');
    expect(payload.symbol).toBe('BTCUSDT');
    expect(payload.interval).toBe('1h');
    expect(payload.totalBars).toBe(4320);
    expect(payload.warmupBars).toBe(200);
    expect(payload.startTime).toBe(1704067200000);
    expect(payload.endTime).toBe(1719792000000);
  });

  it('Moves focus to the results heading on new result', () => {
    render(
      <ResultsView
        result={mockResultFixture}
      />
    );

    const heading = screen.getByRole('heading', { level: 2, name: 'Results' });
    expect(document.activeElement).toBe(heading);
  });

  it('a zero-trade fixture shows "n/a" for win rate, profit factor, Sharpe and expectancy, plus the no-trades line', () => {
    const zeroTradeFixture: BacktestResult = {
      ...mockResultFixture,
      metrics: {
        ...mockResultFixture.metrics,
        totalPnl: 0,
        totalPnlPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        calmarRatio: 0,
        avgWin: 0,
        avgLoss: 0,
        avgWinPercent: 0,
        avgLossPercent: 0,
        totalFees: 0,
        maxConsecutiveWins: 0,
        maxConsecutiveLosses: 0,
        expectancyPercent: 0,
        expectancyR: 0,
        sessionBreakdown: [],
      },
      trades: [],
      equityCurve: [],
    };

    render(<ResultsView result={zeroTradeFixture} />);

    expect(screen.getByTestId('metric-win-rate')).toHaveTextContent('n/a');
    expect(screen.getByTestId('metric-profit-factor')).toHaveTextContent('n/a');
    expect(screen.getByTestId('metric-sharpe')).toHaveTextContent('n/a');
    expect(screen.getByTestId('metric-expectancy')).toHaveTextContent('n/a');
    expect(screen.getByTestId('metric-total-trades')).toHaveTextContent('0');

    expect(screen.getAllByText('No trades were taken in this run.').length).toBeGreaterThanOrEqual(1);
  });

  it('a saved result hides "Save this result"', () => {
    render(<ResultsView result={mockResultFixture} isSavedResult={true} />);

    expect(screen.queryByRole('button', { name: 'Save this result' })).not.toBeInTheDocument();
    expect(screen.getByText('Saved result')).toBeInTheDocument();
  });

  it('renders summary "BTC, 1 hour, 16 trades" for a 16-trade BTCUSDT 1h fixture', () => {
    const fixture16: BacktestResult = {
      ...mockResultFixture,
      symbol: 'BTCUSDT',
      interval: '1h',
      metrics: {
        ...mockResultFixture.metrics,
        totalTrades: 16,
      },
    };

    render(<ResultsView result={fixture16} />);
    expect(screen.getByText('BTC, 1 hour, 16 trades')).toBeInTheDocument();
  });

  it('equity chart XAxis uses type="number" and scale="time"', () => {
    render(<ResultsView result={mockResultFixture} />);

    expect(capturedXAxisProps).toMatchObject({
      type: 'number',
      scale: 'time',
      domain: ['dataMin', 'dataMax'],
      dataKey: 'time',
      minTickGap: 48,
    });
  });
});
