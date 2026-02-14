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

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TriggerOptimizationDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onTriggered: vi.fn(),
  };

  async function renderDialog(props = defaultProps) {
    const { TriggerOptimizationDialog } = await import('./TriggerOptimizationDialog');
    return render(
      React.createElement(TriggerOptimizationDialog, props),
      { wrapper: createWrapper() }
    );
  }

  it('renders dialog when open', async () => {
    await renderDialog();
    expect(screen.getByText('Trigger Monthly Optimization')).toBeInTheDocument();
  });

  it('does not render dialog content when closed', async () => {
    await renderDialog({ ...defaultProps, open: false });
    expect(screen.queryByText('Trigger Monthly Optimization')).not.toBeInTheDocument();
  });

  it('shows form fields', async () => {
    await renderDialog();
    expect(screen.getByLabelText(/Symbols/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Historical Data/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Auto-Activate/i)).toBeInTheDocument();
  });

  it('submits with default values when symbols empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cronRunId: 'new-run' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/trigger-monthly-optimization',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            months: 6,
            autoActivate: true,
          }),
        })
      );
    });
  });

  it('submits with custom symbols', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cronRunId: 'new-run' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderDialog();

    fireEvent.change(screen.getByLabelText(/Symbols/i), {
      target: { value: 'BTCUSDT, ETHUSDT' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/trigger-monthly-optimization',
        expect.objectContaining({
          body: JSON.stringify({
            symbols: ['BTCUSDT', 'ETHUSDT'],
            months: 6,
            autoActivate: true,
          }),
        })
      );
    });
  });

  it('shows error on mutation failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Optimization already running' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(screen.getByText('Optimization already running')).toBeInTheDocument();
    });
  });

  it('calls onTriggered on success', async () => {
    const onTriggered = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cronRunId: 'new-run-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await renderDialog({ ...defaultProps, onTriggered });

    fireEvent.click(screen.getByRole('button', { name: /Start Optimization/i }));

    await waitFor(() => {
      expect(onTriggered).toHaveBeenCalledWith('new-run-123');
    });
  });

  it('shows cancel button', async () => {
    await renderDialog();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });
});
