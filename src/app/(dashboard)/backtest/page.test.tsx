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

vi.mock('@/hooks/useBacktestResults', () => ({
  useSaveBacktestResult: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useBacktestResults: vi.fn(() => ({ data: undefined })),
  useDeleteBacktestResult: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
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

vi.mock('@/components/backtest/DataStatus', () => ({
  DataStatus: () => <div data-testid="data-status" />,
}));

vi.mock('@/components/backtest/WeightSliders', () => ({
  WeightSliders: () => <div data-testid="weight-sliders" />,
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

  it('renders all tabs (Configure, Results, History)', () => {
    render(<BacktestPage />);
    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
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

  it('renders Strategy section heading', () => {
    render(<BacktestPage />);
    expect(screen.getByText('Strategy')).toBeInTheDocument();
  });

  it('renders Market & Data section heading', () => {
    render(<BacktestPage />);
    expect(screen.getByText('Market & Data')).toBeInTheDocument();
  });

  it('renders data range options', () => {
    render(<BacktestPage />);
    expect(screen.getByText('500 bars')).toBeInTheDocument();
    expect(screen.getByText('6 months')).toBeInTheDocument();
    expect(screen.getByText('2 years')).toBeInTheDocument();
  });

  it('renders run summary line', () => {
    render(<BacktestPage />);
    expect(screen.getByTestId('run-summary')).toBeInTheDocument();
  });

  it('renders DataStatus component', () => {
    render(<BacktestPage />);
    expect(screen.getByTestId('data-status')).toBeInTheDocument();
  });
});
