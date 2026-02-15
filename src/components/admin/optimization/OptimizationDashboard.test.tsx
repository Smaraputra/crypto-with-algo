import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  // All child components make fetch calls; mock them to prevent errors
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
});

describe('OptimizationDashboard', () => {
  async function renderComponent() {
    const { OptimizationDashboard } = await import('./OptimizationDashboard');
    return render(
      React.createElement(OptimizationDashboard),
      { wrapper: createWrapper() }
    );
  }

  it('renders all tab triggers', { timeout: 15000 }, async () => {
    await renderComponent();
    expect(screen.getByRole('tab', { name: /New Optimization/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /History/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Cron Runs/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Compare Templates/i })).toBeInTheDocument();
  });

  it('shows "New Optimization" tab as default active tab', async () => {
    await renderComponent();
    const optimizeTab = screen.getByRole('tab', { name: /New Optimization/i });
    expect(optimizeTab).toHaveAttribute('data-state', 'active');
  });

  it('renders OptimizationForm in the default tab', async () => {
    await renderComponent();
    // OptimizationForm renders a card with title "Start New Optimization"
    await waitFor(() => {
      expect(screen.getByText('Start New Optimization')).toBeInTheDocument();
    });
  });

  it('has Compare Templates tab trigger', async () => {
    await renderComponent();
    // Radix Tabs only renders active tab content in jsdom.
    // We verify the tab trigger exists; the placeholder content would
    // appear when the compare tab is activated (tested via E2E).
    const compareTab = screen.getByRole('tab', { name: /Compare Templates/i });
    expect(compareTab).toBeInTheDocument();
    expect(compareTab).toHaveAttribute('data-state', 'inactive');
  });

  it('does not show OptimizationProgress when no active job', async () => {
    await renderComponent();
    // When no activeJobId, no progress component is rendered
    expect(screen.queryByText('Optimization In Progress')).not.toBeInTheDocument();
    expect(screen.queryByText('Optimization Completed')).not.toBeInTheDocument();
  });

  it('renders tab list with 4 tabs', async () => {
    await renderComponent();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
  });
});
