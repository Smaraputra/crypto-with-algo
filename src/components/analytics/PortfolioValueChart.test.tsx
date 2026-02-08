import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('lightweight-charts', () => {
  const mockSeries = {
    setData: vi.fn(),
  };
  const mockTimeScale = {
    fitContent: vi.fn(),
  };
  const mockChart = {
    addSeries: vi.fn().mockReturnValue(mockSeries),
    timeScale: vi.fn().mockReturnValue(mockTimeScale),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  };
  return {
    createChart: vi.fn().mockReturnValue(mockChart),
    AreaSeries: {},
    ColorType: { Solid: 'solid' },
  };
});

function mockFetch(data: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), { status })
  );
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('PortfolioValueChart', () => {
  async function renderChart(portfolioId: string | null = 'p1') {
    const { PortfolioValueChart } = await import('./PortfolioValueChart');
    return render(
      React.createElement(PortfolioValueChart, { portfolioId }),
      { wrapper: createWrapper() }
    );
  }

  it('renders chart card with title', async () => {
    mockFetch({ history: [] });
    await renderChart();
    expect(screen.getByText('Portfolio Value')).toBeInTheDocument();
  });

  it('renders empty state when no snapshot data', async () => {
    mockFetch({ history: [] });
    await renderChart();

    const emptyEl = await screen.findByTestId('chart-empty');
    expect(emptyEl).toHaveTextContent('No snapshot data yet');
  });

  it('renders range selector buttons', async () => {
    mockFetch({ history: [] });
    await renderChart();

    expect(screen.getByTestId('range-7d')).toBeInTheDocument();
    expect(screen.getByTestId('range-30d')).toBeInTheDocument();
    expect(screen.getByTestId('range-90d')).toBeInTheDocument();
    expect(screen.getByTestId('range-1y')).toBeInTheDocument();
  });

  it('renders chart container when data exists', async () => {
    const mockHistory = {
      history: [
        { date: '2024-01-01T00:00:00.000Z', totalValue: 25000, totalCost: 24000, unrealizedPnl: 1000, unrealizedPnlPercent: 4.17 },
        { date: '2024-01-02T00:00:00.000Z', totalValue: 26000, totalCost: 24000, unrealizedPnl: 2000, unrealizedPnlPercent: 8.33 },
      ],
    };
    mockFetch(mockHistory);
    await renderChart();

    const container = await screen.findByTestId('chart-container');
    expect(container).toBeInTheDocument();
  });

  it('changes range when button clicked', async () => {
    const fetchSpy = mockFetch({ history: [] });
    await renderChart();

    fireEvent.click(screen.getByTestId('range-7d'));

    // Should trigger a new fetch with range=7
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((url) => url.includes('range=7'))).toBe(true);
    });
  });

  it('renders nothing for chart when portfolioId is null', async () => {
    mockFetch({ history: [] });
    await renderChart(null);

    expect(screen.getByText('Portfolio Value')).toBeInTheDocument();
    // Should show empty state since hook won't fetch
    expect(screen.getByTestId('chart-empty')).toBeInTheDocument();
  });
});
