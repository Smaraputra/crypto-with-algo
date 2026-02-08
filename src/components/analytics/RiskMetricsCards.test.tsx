import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function mockFetch(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), { status: 200 })
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

describe('RiskMetricsCards', () => {
  async function renderCards(portfolioId: string | null = 'p1') {
    const { RiskMetricsCards } = await import('./RiskMetricsCards');
    return render(
      React.createElement(RiskMetricsCards, { portfolioId, range: 90 }),
      { wrapper: createWrapper() }
    );
  }

  it('shows insufficient data message', async () => {
    mockFetch({
      metrics: null,
      insufficientData: true,
      dataPoints: 5,
      minRequired: 30,
    });

    await renderCards();

    const el = await screen.findByTestId('risk-metrics-insufficient');
    expect(el).toHaveTextContent('Insufficient data');
    expect(el).toHaveTextContent('25 more days');
    expect(el).toHaveTextContent('5 of 30');
  });

  it('renders metric cards when data is sufficient', async () => {
    mockFetch({
      metrics: {
        annualizedVolatility: 0.42,
        maxDrawdown: -0.15,
        maxDrawdownDate: '2024-01-20',
        sharpeRatio: 1.8,
        sortinoRatio: 2.3,
        bestDay: { date: '2024-01-10', return: 0.08 },
        worstDay: { date: '2024-01-20', return: -0.06 },
        annualizedReturn: 0.85,
        totalReturn: 0.12,
        dataPoints: 30,
      },
      insufficientData: false,
      dataPoints: 30,
      minRequired: 30,
    });

    await renderCards();

    const cards = await screen.findByTestId('risk-metrics-cards');
    expect(cards).toBeInTheDocument();
    expect(screen.getByText('Sharpe Ratio')).toBeInTheDocument();
    expect(screen.getByText('Sortino Ratio')).toBeInTheDocument();
    expect(screen.getByText('Max Drawdown')).toBeInTheDocument();
    expect(screen.getByText('Volatility')).toBeInTheDocument();
    expect(screen.getByText('Best Day')).toBeInTheDocument();
    expect(screen.getByText('Worst Day')).toBeInTheDocument();
  });

  it('displays formatted ratio values', async () => {
    mockFetch({
      metrics: {
        annualizedVolatility: 0.42,
        maxDrawdown: -0.15,
        maxDrawdownDate: '2024-01-20',
        sharpeRatio: 1.8,
        sortinoRatio: 2.3,
        bestDay: { date: '2024-01-10', return: 0.08 },
        worstDay: { date: '2024-01-20', return: -0.06 },
        annualizedReturn: 0.85,
        totalReturn: 0.12,
        dataPoints: 30,
      },
      insufficientData: false,
      dataPoints: 30,
      minRequired: 30,
    });

    await renderCards();

    await screen.findByTestId('risk-metrics-cards');
    expect(screen.getByText('1.80')).toBeInTheDocument();
    expect(screen.getByText('2.30')).toBeInTheDocument();
  });
});
