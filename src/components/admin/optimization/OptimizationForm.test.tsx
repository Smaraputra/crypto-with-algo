import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
  unobserve() {}
});

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

describe('OptimizationForm', () => {
  const defaultProps = {
    onOptimizationStarted: vi.fn(),
    disabled: false,
  };

  async function renderComponent(props = defaultProps) {
    const { OptimizationForm } = await import('./OptimizationForm');
    return render(
      React.createElement(OptimizationForm, props),
      { wrapper: createWrapper() }
    );
  }

  it('renders card with title and description', { timeout: 15000 }, async () => {
    await renderComponent();
    expect(screen.getByText('Start New Optimization')).toBeInTheDocument();
    expect(screen.getByText(/Configure parameters for walk-forward optimization/)).toBeInTheDocument();
  });

  it('renders all form fields', async () => {
    await renderComponent();
    expect(screen.getByText('Trading Style')).toBeInTheDocument();
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Timeframe')).toBeInTheDocument();
    expect(screen.getByText(/Historical Data Period/)).toBeInTheDocument();
  });

  it('shows default symbol value', async () => {
    await renderComponent();
    const symbolInput = screen.getByPlaceholderText('BTCUSDT');
    expect(symbolInput).toBeInTheDocument();
    expect(symbolInput).toHaveValue('BTCUSDT');
  });

  it('shows submit button with correct text', async () => {
    await renderComponent();
    expect(screen.getByRole('button', { name: /Start Optimization/i })).toBeInTheDocument();
  });

  it('shows estimated runtime info', async () => {
    await renderComponent();
    expect(screen.getByText(/Estimated runtime/)).toBeInTheDocument();
  });

  it('shows weight combinations estimate', async () => {
    await renderComponent();
    // Text is split across child elements, so use a function matcher
    expect(screen.getByText((_content, element) => {
      return element?.tagName === 'P' && /Will test ~\d+ weight combinations/.test(element.textContent ?? '');
    })).toBeInTheDocument();
  });

  it('submits form with default values', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'new-job-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderComponent();

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/optimize-template',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            tradingStyle: 'day_trading',
            symbol: 'BTCUSDT',
            interval: '1h',
            months: 6,
          }),
        })
      );
    });
  });

  it('calls onOptimizationStarted with jobId on success', async () => {
    const onOptimizationStarted = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'new-job-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderComponent({ ...defaultProps, onOptimizationStarted });

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(onOptimizationStarted).toHaveBeenCalledWith('new-job-123');
    });
  });

  it('shows error message on mutation failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Optimization already in progress' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderComponent();

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(screen.getByText('Optimization already in progress')).toBeInTheDocument();
    });
  });

  it('shows default error message when API returns no error field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderComponent();

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to start optimization')).toBeInTheDocument();
    });
  });

  it('disables submit button when disabled prop is true', async () => {
    await renderComponent({ ...defaultProps, disabled: true });
    expect(screen.getByRole('button', { name: /Start Optimization/i })).toBeDisabled();
  });

  it('uppercases symbol input', async () => {
    await renderComponent();
    const symbolInput = screen.getByPlaceholderText('BTCUSDT');
    fireEvent.change(symbolInput, { target: { value: 'ethusdt' } });
    expect(symbolInput).toHaveValue('ETHUSDT');
  });

  it('submits with custom symbol', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'new-job-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderComponent();

    const symbolInput = screen.getByPlaceholderText('BTCUSDT');
    fireEvent.change(symbolInput, { target: { value: 'ETHUSDT' } });

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/optimize-template',
        expect.objectContaining({
          body: expect.stringContaining('"symbol":"ETHUSDT"'),
        })
      );
    });
  });

  it('shows form field descriptions', async () => {
    await renderComponent();
    expect(screen.getByText('The trading timeframe to optimize')).toBeInTheDocument();
    expect(screen.getByText(/Trading pair symbol/)).toBeInTheDocument();
    expect(screen.getByText('Candlestick interval for historical data')).toBeInTheDocument();
    expect(screen.getByText(/Amount of historical data to analyze/)).toBeInTheDocument();
  });
});
