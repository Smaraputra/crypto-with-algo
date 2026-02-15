import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function mockFetchResponse(data: unknown, ok = true) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), {
      status: ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function mockFetchError() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
  );
}

const mockCurrentTemplate = {
  id: 'template-current',
  tradingStyle: 'day_trading',
  version: 1,
  weights: {
    trend: 0.25,
    momentum: 0.25,
    volume: 0.15,
    volatility: 0.10,
    futures: 0.15,
    sentiment: 0.10,
  },
  thresholds: {
    entryThreshold: 60,
    exitThreshold: 40,
    shortEntryThreshold: -60,
    shortExitThreshold: -40,
  },
  performanceMetrics: {
    avgSharpe: 1.2,
    avgWinRate: 0.55,
    totalBacktests: 100,
    lastOptimizedAt: '2025-01-15T10:00:00.000Z',
  },
  active: true,
};

const mockOptimizedTemplate = {
  id: 'template-optimized',
  tradingStyle: 'day_trading',
  version: 2,
  weights: {
    trend: 0.30,
    momentum: 0.20,
    volume: 0.20,
    volatility: 0.05,
    futures: 0.15,
    sentiment: 0.10,
  },
  thresholds: {
    entryThreshold: 65,
    exitThreshold: 35,
    shortEntryThreshold: -65,
    shortExitThreshold: -35,
  },
  performanceMetrics: {
    avgSharpe: 1.5,
    avgWinRate: 0.62,
    totalBacktests: 150,
    lastOptimizedAt: '2025-02-01T10:00:00.000Z',
  },
  active: false,
};

const mockComparisonWithCurrent = {
  currentTemplate: mockCurrentTemplate,
  optimizedTemplate: mockOptimizedTemplate,
};

const mockComparisonWithoutCurrent = {
  currentTemplate: null,
  optimizedTemplate: mockOptimizedTemplate,
};

const mockComparisonActiveOptimized = {
  currentTemplate: mockCurrentTemplate,
  optimizedTemplate: { ...mockOptimizedTemplate, active: true },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TemplateComparison', () => {
  const defaultProps = {
    templateId: 'template-optimized',
  };

  async function renderComponent(props = defaultProps) {
    const { TemplateComparison } = await import('./TemplateComparison');
    return render(
      React.createElement(TemplateComparison, props),
      { wrapper: createWrapper() }
    );
  }

  it('shows loading spinner while fetching', { timeout: 15000 }, async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    await renderComponent();
    const spinner = document.querySelector('[class*="animate-spin"]');
    expect(spinner).toBeTruthy();
  });

  it('shows error alert on fetch failure', async () => {
    mockFetchError();
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load template comparison/i)).toBeInTheDocument();
    });
  });

  it('fetches comparison data from correct API endpoint', async () => {
    const fetchSpy = mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/admin/template-comparison/template-optimized');
    });
  });

  it('renders card title "Template Comparison"', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Template Comparison')).toBeInTheDocument();
    });
  });

  it('shows trading style and version', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/day trading/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Version 2/)).toBeInTheDocument();
  });

  it('shows Activate Template button when not active', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Activate Template/i })).toBeInTheDocument();
    });
  });

  it('shows Active badge when optimized template is active', async () => {
    mockFetchResponse(mockComparisonActiveOptimized);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Activate Template/i })).not.toBeInTheDocument();
  });

  it('displays optimized sharpe ratio', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('1.50')).toBeInTheDocument();
    });
  });

  it('displays current sharpe ratio for comparison', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Current: 1.20')).toBeInTheDocument();
    });
  });

  it('displays optimized win rate as percentage', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('62.0%')).toBeInTheDocument();
    });
  });

  it('displays current win rate for comparison', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Current: 55.0%')).toBeInTheDocument();
    });
  });

  it('displays total backtests count', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('150')).toBeInTheDocument();
    });
    expect(screen.getByText('windows')).toBeInTheDocument();
  });

  it('renders all weight categories', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('trend')).toBeInTheDocument();
    });
    expect(screen.getByText('momentum')).toBeInTheDocument();
    expect(screen.getByText('volume')).toBeInTheDocument();
    expect(screen.getByText('volatility')).toBeInTheDocument();
    expect(screen.getByText('futures')).toBeInTheDocument();
    expect(screen.getByText('sentiment')).toBeInTheDocument();
  });

  it('renders section headings', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Performance Metrics')).toBeInTheDocument();
    });
    expect(screen.getByText('Signal Weights')).toBeInTheDocument();
    expect(screen.getByText('Signal Thresholds')).toBeInTheDocument();
  });

  it('displays threshold values', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('65')).toBeInTheDocument();
    });
    expect(screen.getByText('35')).toBeInTheDocument();
    expect(screen.getByText('-65')).toBeInTheDocument();
    expect(screen.getByText('-35')).toBeInTheDocument();
  });

  it('displays threshold labels', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Long Entry')).toBeInTheDocument();
    });
    expect(screen.getByText('Long Exit')).toBeInTheDocument();
    expect(screen.getByText('Short Entry')).toBeInTheDocument();
    expect(screen.getByText('Short Exit')).toBeInTheDocument();
  });

  it('renders without current template (no comparison data)', async () => {
    mockFetchResponse(mockComparisonWithoutCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Template Comparison')).toBeInTheDocument();
    });
    // Should still show optimized values
    expect(screen.getByText('1.50')).toBeInTheDocument();
    // Should not show "Current:" labels
    expect(screen.queryByText(/Current:/)).not.toBeInTheDocument();
  });

  it('calls activate mutation when Activate button is clicked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockComparisonWithCurrent), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      // Refetch after invalidation
      .mockResolvedValue(
        new Response(JSON.stringify(mockComparisonActiveOptimized), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    await renderComponent();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Activate Template/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Activate Template/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/activate-template',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ templateId: 'template-optimized' }),
        })
      );
    });
  });

  it('shows success alert after activation', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockComparisonWithCurrent), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValue(
        new Response(JSON.stringify(mockComparisonActiveOptimized), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    await renderComponent();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Activate Template/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Activate Template/i }));

    await waitFor(() => {
      expect(screen.getByText('Template Activated')).toBeInTheDocument();
    });
    expect(screen.getByText(/The optimized template is now active/)).toBeInTheDocument();
  });

  it('shows Sharpe Ratio label', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Sharpe Ratio')).toBeInTheDocument();
    });
  });

  it('shows Win Rate label', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Win Rate')).toBeInTheDocument();
    });
  });

  it('shows Total Backtests label', async () => {
    mockFetchResponse(mockComparisonWithCurrent);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Total Backtests')).toBeInTheDocument();
    });
  });
});
