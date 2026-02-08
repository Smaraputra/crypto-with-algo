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

describe('AnalyticsSummaryCards', () => {
  async function renderCards(portfolioId: string | null = 'p1') {
    const { AnalyticsSummaryCards } = await import('./AnalyticsSummaryCards');
    return render(
      React.createElement(AnalyticsSummaryCards, { portfolioId, range: 30 }),
      { wrapper: createWrapper() }
    );
  }

  it('shows loading skeleton initially', async () => {
    mockFetch({ history: [] });
    await renderCards();
    expect(screen.getByTestId('summary-cards-skeleton')).toBeInTheDocument();
  });

  it('has aria-live on loading skeleton', async () => {
    mockFetch({ history: [] });
    await renderCards();
    const skeleton = screen.getByTestId('summary-cards-skeleton');
    expect(skeleton).toHaveAttribute('aria-live', 'polite');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  it('renders summary cards with values', async () => {
    // Mock history and cost-basis responses
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes('history')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            history: [
              { date: '2024-01-01', totalValue: 24000, totalCost: 25000, unrealizedPnl: -1000, unrealizedPnlPercent: -4 },
              { date: '2024-01-30', totalValue: 28000, totalCost: 25000, unrealizedPnl: 3000, unrealizedPnlPercent: 12 },
            ],
          }))
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({
          costBasis: { holdings: [], totalRealizedGain: 5000, totalUnrealizedCostBasis: 25000 },
        }))
      );
    });

    await renderCards();

    const cards = await screen.findByTestId('analytics-summary-cards');
    expect(cards).toBeInTheDocument();
    expect(screen.getByText('Total Value')).toBeInTheDocument();
    expect(screen.getByText('Unrealized P&L')).toBeInTheDocument();
    expect(screen.getByText('Realized P&L')).toBeInTheDocument();
    expect(screen.getByText('Period Return')).toBeInTheDocument();
  });
});
