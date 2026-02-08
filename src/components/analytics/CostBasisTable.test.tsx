import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('CostBasisTable', () => {
  async function renderTable(portfolioId: string | null = 'p1') {
    const { CostBasisTable } = await import('./CostBasisTable');
    return render(
      React.createElement(CostBasisTable, { portfolioId }),
      { wrapper: createWrapper() }
    );
  }

  it('shows empty state when no holdings', async () => {
    mockFetch({
      costBasis: { holdings: [], totalRealizedGain: 0, totalUnrealizedCostBasis: 0 },
    });

    await renderTable();

    const empty = await screen.findByTestId('cost-basis-empty');
    expect(empty).toHaveTextContent('No holdings to analyze');
  });

  it('renders table with holdings data', async () => {
    mockFetch({
      costBasis: {
        holdings: [
          {
            symbol: 'BTCUSDT',
            totalQuantity: 0.5,
            averageCost: 40000,
            totalCost: 20000,
            openLots: [],
            realizedGains: [],
            totalRealizedGain: 5000,
          },
        ],
        totalRealizedGain: 5000,
        totalUnrealizedCostBasis: 20000,
      },
    });

    await renderTable();

    const table = await screen.findByTestId('cost-basis-table');
    expect(table).toBeInTheDocument();
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('Cost Basis (FIFO)')).toBeInTheDocument();
    expect(screen.getByTestId('method-selector')).toBeInTheDocument();
  });

  it('expands row to show tax lots on click', async () => {
    mockFetch({
      costBasis: {
        holdings: [
          {
            symbol: 'BTCUSDT',
            totalQuantity: 0.5,
            averageCost: 40000,
            totalCost: 20000,
            openLots: [
              { date: '2024-01-15', quantity: 0.5, pricePerUnit: 40000, fee: 10, remainingQuantity: 0.5 },
            ],
            realizedGains: [],
            totalRealizedGain: 0,
          },
        ],
        totalRealizedGain: 0,
        totalUnrealizedCostBasis: 20000,
      },
    });

    await renderTable();

    const row = await screen.findByTestId('row-BTCUSDT');
    fireEvent.click(row);

    expect(screen.getByText('Open Tax Lots')).toBeInTheDocument();
  });

  it('shows export CSV button when holdings exist', async () => {
    mockFetch({
      costBasis: {
        holdings: [
          {
            symbol: 'BTCUSDT',
            totalQuantity: 0.5,
            averageCost: 40000,
            totalCost: 20000,
            openLots: [],
            realizedGains: [],
            totalRealizedGain: 5000,
          },
        ],
        totalRealizedGain: 5000,
        totalUnrealizedCostBasis: 20000,
      },
    });

    await renderTable();

    await screen.findByTestId('cost-basis-table');
    expect(screen.getByTestId('export-csv-button')).toBeInTheDocument();
    expect(screen.getByTestId('export-csv-button')).toHaveTextContent('Export CSV');
  });

  it('shows total row', async () => {
    mockFetch({
      costBasis: {
        holdings: [
          {
            symbol: 'BTCUSDT',
            totalQuantity: 0.5,
            averageCost: 40000,
            totalCost: 20000,
            openLots: [],
            realizedGains: [],
            totalRealizedGain: 5000,
          },
        ],
        totalRealizedGain: 5000,
        totalUnrealizedCostBasis: 20000,
      },
    });

    await renderTable();

    await screen.findByTestId('cost-basis-table');
    expect(screen.getByText('Total')).toBeInTheDocument();
  });
});
