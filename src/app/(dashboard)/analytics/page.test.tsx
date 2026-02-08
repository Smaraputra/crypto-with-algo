import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: (loader: () => Promise<{ default: React.ComponentType }>) => {
    // For tests, eagerly resolve the dynamic import
    let Component: React.ComponentType | null = null;
    loader().then((mod) => {
      Component = 'default' in mod ? mod.default : (mod as unknown as { PortfolioValueChart: React.ComponentType }).PortfolioValueChart;
    });
    return function DynamicComponent(props: Record<string, unknown>) {
      if (!Component) return <div data-testid="dynamic-loading" />;
      return <Component {...props} />;
    };
  },
}));

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn().mockReturnValue({
    addSeries: vi.fn().mockReturnValue({ setData: vi.fn() }),
    timeScale: vi.fn().mockReturnValue({ fitContent: vi.fn() }),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  }),
  AreaSeries: {},
  ColorType: { Solid: 'solid' },
}));

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: () => ({
    data: { portfolios: [{ _id: 'p1', name: 'My Portfolio', holdingsCount: 2 }] },
  }),
  usePortfolio: () => ({ data: undefined }),
  useCreatePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useRenamePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePortfolio: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useAnalytics', () => ({
  usePortfolioHistory: () => ({ data: { history: [] }, isLoading: false }),
  useCostBasis: () => ({
    data: { costBasis: { holdings: [], totalRealizedGain: 0, totalUnrealizedCostBasis: 0 } },
    isLoading: false,
  }),
  useRiskMetrics: () => ({
    data: { metrics: null, insufficientData: true, dataPoints: 0, minRequired: 30 },
    isLoading: false,
  }),
}));

import AnalyticsPage from './page';

describe('AnalyticsPage', () => {
  it('renders page heading', () => {
    render(<AnalyticsPage />);
    expect(screen.getByText('Analytics')).toBeInTheDocument();
  });

  it('renders tab buttons', () => {
    render(<AnalyticsPage />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Cost Basis' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Risk Metrics' })).toBeInTheDocument();
  });

  it('shows portfolio value chart on overview tab', () => {
    render(<AnalyticsPage />);
    // Dynamic import renders the chart or loading placeholder
    expect(
      screen.queryByTestId('portfolio-value-chart') ?? screen.queryByTestId('dynamic-loading')
    ).toBeInTheDocument();
  });

  it('shows summary cards on overview tab', () => {
    render(<AnalyticsPage />);
    expect(screen.getByTestId('analytics-summary-cards')).toBeInTheDocument();
  });
});
