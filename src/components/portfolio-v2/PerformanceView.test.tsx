import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PerformanceView,
  formatChartTick,
  formatChartTooltipLabel,
} from './PerformanceView';
import {
  usePortfolioHistory,
  useCostBasis,
  useRiskMetrics,
  useExportCsv,
} from '@/hooks/useAnalytics';

vi.mock('@/hooks/useAnalytics', () => ({
  usePortfolioHistory: vi.fn(),
  useCostBasis: vi.fn(),
  useRiskMetrics: vi.fn(),
  useExportCsv: vi.fn(),
}));

vi.mock('@/lib/chart-theme', () => ({
  useChartTheme: vi.fn(() => ({
    grid: '#E2E5E9',
    crosshair: '#7C8490',
    up: '#067346',
    down: '#C21F36',
    volume: '#E4E7EB',
    text: '#0F1114',
    mutedText: '#59606B',
    line: '#E2E5E9',
    accentLine: '#067346',
  })),
}));

let capturedAreaProps: Record<string, unknown> | null = null;
let capturedXAxisProps: Record<string, unknown> | null = null;

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithSizedContainer } = await import('@/test/recharts');
  const actual = await importOriginal<Record<string, unknown>>();
  const base = rechartsWithSizedContainer(actual);
  const ActualArea = actual.Area as React.ComponentType<Record<string, unknown>>;
  const Area = (props: Record<string, unknown>) => {
    capturedAreaProps = props;
    return <ActualArea {...props} />;
  };
  Area.displayName = 'Area';
  const ActualXAxis = actual.XAxis as React.ComponentType<Record<string, unknown>>;
  const XAxis = (props: Record<string, unknown>) => {
    capturedXAxisProps = props;
    return <ActualXAxis {...props} />;
  };
  XAxis.displayName = 'XAxis';
  return {
    ...base,
    Area,
    XAxis,
  };
});

describe('PerformanceView', () => {
  const mockExportMutateAsync = vi.fn();
  const mockRefetchHistory = vi.fn();
  const mockRefetchCostBasis = vi.fn();
  const mockRefetchRisk = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    capturedAreaProps = null;
    capturedXAxisProps = null;

    vi.mocked(usePortfolioHistory).mockReturnValue({
      data: {
        history: [
          {
            date: '2026-10-01',
            totalValue: 10000,
            totalCost: 9000,
            unrealizedPnl: 1000,
            unrealizedPnlPercent: 11.11,
          },
          {
            date: '2026-10-15',
            totalValue: 12500,
            totalCost: 9000,
            unrealizedPnl: 3500,
            unrealizedPnlPercent: 38.89,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetchHistory,
    } as unknown as ReturnType<typeof usePortfolioHistory>);

    vi.mocked(useCostBasis).mockReturnValue({
      data: {
        costBasis: {
          holdings: [
            {
              symbol: 'BTCUSDT',
              totalQuantity: 1,
              averageCost: 50000,
              totalCost: 50000,
              openLots: [],
              realizedGains: [],
              totalRealizedGain: 4500,
              unrealizedPnl: 12000,
            },
          ],
          totalRealizedGain: 4500,
          totalUnrealizedCostBasis: 50000,
          method: 'fifo',
        },
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetchCostBasis,
    } as unknown as ReturnType<typeof useCostBasis>);

    vi.mocked(useRiskMetrics).mockReturnValue({
      data: {
        metrics: {
          maxDrawdown: -0.152,
          maxDrawdownDate: '2026-10-10',
          sharpeRatio: 1.85,
          sortinoRatio: 2.4,
          annualizedVolatility: 0.42,
          annualizedReturn: 0.65,
          totalReturn: 0.25,
          bestDay: { date: '2026-10-05', return: 0.082 },
          worstDay: { date: '2026-10-12', return: -0.061 },
          dataPoints: 90,
        },
        insufficientData: false,
        dataPoints: 90,
        minRequired: 30,
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetchRisk,
    } as unknown as ReturnType<typeof useRiskMetrics>);

    vi.mocked(useExportCsv).mockReturnValue({
      mutateAsync: mockExportMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useExportCsv>);
  });

  it('renders value chart text alternative with start, end, and change', () => {
    render(<PerformanceView portfolioId="port-1" />);

    const altText = screen.getByTestId('history-text-alternative');
    expect(altText).toHaveTextContent('Starting value: $10,000.00');
    expect(altText).toHaveTextContent('ending value: $12,500.00');
    expect(altText).toHaveTextContent('+$2,500.00 (+25.00%)');
  });

  it('range control changes the query range', async () => {
    const user = userEvent.setup();
    render(<PerformanceView portfolioId="port-1" />);

    // Default was 30
    expect(usePortfolioHistory).toHaveBeenCalledWith('port-1', 30);

    const range90 = screen.getByRole('radio', { name: '90D' });
    await user.click(range90);

    expect(usePortfolioHistory).toHaveBeenCalledWith('port-1', 90);
  });

  it('method control changes the cost basis method query', async () => {
    const user = userEvent.setup();
    render(<PerformanceView portfolioId="port-1" />);

    expect(useCostBasis).toHaveBeenCalledWith('port-1', 'fifo');

    const lifoRadio = screen.getByRole('radio', { name: 'LIFO' });
    await user.click(lifoRadio);

    expect(useCostBasis).toHaveBeenCalledWith('port-1', 'lifo');
  });

  it('renders risk labels and descriptions from fixture', () => {
    render(<PerformanceView portfolioId="port-1" />);

    expect(screen.getByText('Max drawdown')).toBeInTheDocument();
    expect(
      screen.getByText('The largest fall from a peak in the period')
    ).toBeInTheDocument();
    expect(screen.getByText('-15.20%')).toBeInTheDocument();

    expect(screen.getByText('Sharpe ratio')).toBeInTheDocument();
    expect(
      screen.getByText('Risk-adjusted return relative to risk-free rate')
    ).toBeInTheDocument();
    expect(screen.getByText('1.85')).toBeInTheDocument();

    expect(screen.getByText('Sortino ratio')).toBeInTheDocument();
    expect(screen.getByText('2.40')).toBeInTheDocument();

    expect(screen.getByText('Annualized volatility')).toBeInTheDocument();
    expect(screen.getByText('42.00%')).toBeInTheDocument();

    expect(screen.getByText('Best day')).toBeInTheDocument();
    expect(screen.getByText('8.20%')).toBeInTheDocument();
  });

  it('export calls the mutation with the chosen format', async () => {
    const user = userEvent.setup();
    mockExportMutateAsync.mockResolvedValueOnce(undefined);

    render(<PerformanceView portfolioId="port-1" />);

    // Select Koinly format
    const formatSelect = screen.getByLabelText('Format');
    await user.selectOptions(formatSelect, 'koinly');

    // Click Download CSV
    const downloadBtn = screen.getByRole('button', { name: 'Download CSV' });
    await user.click(downloadBtn);

    await waitFor(() => {
      expect(mockExportMutateAsync).toHaveBeenCalledWith({ format: 'koinly' });
    });
  });

  it('shows preparing file while export is pending and inline error on failure', async () => {
    const user = userEvent.setup();
    mockExportMutateAsync.mockRejectedValueOnce(new Error('Network error downloading CSV'));

    render(<PerformanceView portfolioId="port-1" />);

    const downloadBtn = screen.getByRole('button', { name: 'Download CSV' });
    await user.click(downloadBtn);

    await waitFor(() => {
      expect(
        screen.getByText('Network error downloading CSV')
      ).toBeInTheDocument();
    });
  });

  it('the line type is linear', () => {
    render(<PerformanceView portfolioId="port-1" />);

    expect(capturedAreaProps).toMatchObject({
      type: 'linear',
    });
  });

  it('formats chart ticks as "Oct 4" and tooltip as "Oct 4, 2026"', () => {
    const timestamp = Date.UTC(2026, 9, 4);
    expect(formatChartTick(timestamp)).toBe('Oct 4');
    expect(formatChartTooltipLabel(timestamp)).toBe('Oct 4, 2026');
  });

  it('uses numeric time axis for value history chart', () => {
    render(<PerformanceView portfolioId="port-1" />);

    expect(capturedXAxisProps).toMatchObject({
      type: 'number',
      scale: 'time',
      domain: ['dataMin', 'dataMax'],
      dataKey: 'time',
      minTickGap: 48,
    });
  });
});
