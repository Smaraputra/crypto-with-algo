import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useStrategies', () => ({
  useStrategies: vi.fn(() => ({ data: undefined, isLoading: false })),
  useCreateStrategy: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateStrategy: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteStrategy: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock('@/hooks/useBacktest', () => ({
  useBacktest: vi.fn(() => ({
    status: 'idle',
    progress: 0,
    barsProcessed: 0,
    totalBars: 0,
    result: null,
    error: null,
    run: vi.fn(),
    cancel: vi.fn(),
  })),
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: vi.fn(() => 'BTCUSDT'),
}));

vi.mock('@/components/backtest/StrategyForm', () => ({
  StrategyForm: () => null,
}));

vi.mock('@/components/backtest/StrategyList', () => ({
  StrategyList: ({ strategies }: { strategies: unknown[] }) => (
    <div data-testid="strategy-list">{strategies.length} strategies</div>
  ),
}));

vi.mock('@/components/backtest/BacktestConfigPanel', () => ({
  BacktestConfigPanel: () => <div data-testid="backtest-config-panel" />,
}));

vi.mock('@/components/backtest/BacktestProgress', () => ({
  BacktestProgress: () => <div data-testid="backtest-progress" />,
}));

vi.mock('@/components/backtest/EquityCurveChart', () => ({
  EquityCurveChart: () => <div data-testid="equity-curve-chart" />,
}));

vi.mock('@/components/backtest/BacktestMetricsCards', () => ({
  BacktestMetricsCards: () => <div data-testid="backtest-metrics" />,
}));

vi.mock('@/components/backtest/TradeList', () => ({
  TradeList: () => <div data-testid="trade-list" />,
}));

import BacktestPage from './page';

describe('BacktestPage', () => {
  it('renders page heading', () => {
    render(<BacktestPage />);
    expect(screen.getByText('Backtest')).toBeInTheDocument();
  });

  it('renders New Strategy button', () => {
    render(<BacktestPage />);
    expect(screen.getByText('New Strategy')).toBeInTheDocument();
  });

  it('renders Configure and Results tabs', () => {
    render(<BacktestPage />);
    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Results')).toBeInTheDocument();
  });

  it('renders Run Backtest button', () => {
    render(<BacktestPage />);
    expect(screen.getByText('Run Backtest')).toBeInTheDocument();
  });

  it('renders interval selector buttons', () => {
    render(<BacktestPage />);
    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('4h')).toBeInTheDocument();
    expect(screen.getByText('1d')).toBeInTheDocument();
  });

  it('renders config panel', () => {
    render(<BacktestPage />);
    expect(screen.getByTestId('backtest-config-panel')).toBeInTheDocument();
  });
});
