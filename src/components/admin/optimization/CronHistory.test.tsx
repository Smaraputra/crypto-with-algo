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

const mockCompletedRun = {
  id: 'run1',
  type: 'monthly_optimization',
  scheduledAt: '2025-02-01T10:00:00.000Z',
  startedAt: '2025-02-01T10:00:05.000Z',
  completedAt: '2025-02-01T10:05:30.000Z',
  status: 'completed' as const,
  jobs: [
    {
      tradingStyle: 'scalping',
      symbol: 'BTCUSDT',
      interval: '1m',
      jobId: 'job1',
      status: 'completed' as const,
      startedAt: '2025-02-01T10:00:05.000Z',
      completedAt: '2025-02-01T10:02:00.000Z',
      error: null,
      activated: true,
      activationReason: 'Improved performance',
    },
    {
      tradingStyle: 'day_trading',
      symbol: 'ETHUSDT',
      interval: '1h',
      jobId: 'job2',
      status: 'failed' as const,
      startedAt: '2025-02-01T10:02:00.000Z',
      completedAt: '2025-02-01T10:03:00.000Z',
      error: 'Binance API 403',
      activated: false,
      activationReason: null,
    },
  ],
  summary: {
    totalJobs: 2,
    completedJobs: 1,
    failedJobs: 1,
    activatedTemplates: 1,
  },
  error: null,
  createdAt: '2025-02-01T10:00:00.000Z',
};

const mockRunningRun = {
  id: 'run2',
  type: 'monthly_optimization',
  scheduledAt: '2025-02-15T10:00:00.000Z',
  startedAt: '2025-02-15T10:00:05.000Z',
  completedAt: null,
  status: 'running' as const,
  jobs: [
    {
      tradingStyle: 'scalping',
      symbol: 'BTCUSDT',
      interval: '1m',
      jobId: 'job3',
      status: 'completed' as const,
      startedAt: null,
      completedAt: null,
      error: null,
      activated: false,
      activationReason: null,
    },
    {
      tradingStyle: 'day_trading',
      symbol: '',
      interval: '',
      jobId: null,
      status: 'pending' as const,
      startedAt: null,
      completedAt: null,
      error: null,
      activated: false,
      activationReason: null,
    },
  ],
  summary: {
    totalJobs: 2,
    completedJobs: 1,
    failedJobs: 0,
    activatedTemplates: 0,
  },
  error: null,
  createdAt: '2025-02-15T10:00:00.000Z',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('CronHistory', () => {
  async function renderComponent() {
    const { CronHistory } = await import('./CronHistory');
    return render(React.createElement(CronHistory), { wrapper: createWrapper() });
  }

  it('shows loading spinner while fetching', async () => {
    // Never resolve the fetch
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    await renderComponent();
    const spinner = document.querySelector('[class*="animate-spin"]');
    expect(spinner).toBeTruthy();
  });

  it('shows error alert on fetch failure', async () => {
    mockFetchError();
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load cron run history/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when no cron runs', async () => {
    mockFetchResponse([]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('No cron runs yet')).toBeInTheDocument();
    });
  });

  it('renders table with correct headers', async () => {
    mockFetchResponse([mockCompletedRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Date')).toBeInTheDocument();
    });
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Activated')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
  });

  it('renders cron run rows with correct data', async () => {
    mockFetchResponse([mockCompletedRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Feb 1, 2025')).toBeInTheDocument();
    });
    expect(screen.getByText('completed')).toBeInTheDocument();
    // Jobs column: completedJobs/totalJobs
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('displays status badges with correct text', async () => {
    mockFetchResponse([mockCompletedRun, mockRunningRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument();
    });
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('shows "Trigger Optimization" button', async () => {
    mockFetchResponse([]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Trigger Optimization/i })).toBeInTheDocument();
    });
  });

  it('shows duration for completed runs', async () => {
    mockFetchResponse([mockCompletedRun]);
    await renderComponent();
    await waitFor(() => {
      // 5m 25s (from 10:00:05 to 10:05:30)
      expect(screen.getByText('5m 25s')).toBeInTheDocument();
    });
  });

  it('shows "Running..." for running runs', async () => {
    mockFetchResponse([mockRunningRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Running...')).toBeInTheDocument();
    });
  });

  it('shows progress for running runs', async () => {
    mockFetchResponse([mockRunningRun]);
    await renderComponent();
    await waitFor(() => {
      // completed + failed / total = 1+0/2
      expect(screen.getByText('1/2')).toBeInTheDocument();
    });
  });

  it('shows expand toggle and expands on click', async () => {
    mockFetchResponse([mockCompletedRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByLabelText('Expand row')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Expand row'));

    await waitFor(() => {
      expect(screen.getByLabelText('Collapse row')).toBeInTheDocument();
    });
    // Job details should be visible
    expect(screen.getByText('scalping')).toBeInTheDocument();
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
  });

  it('shows job details in expanded row', async () => {
    mockFetchResponse([mockCompletedRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByLabelText('Expand row')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Expand row'));

    await waitFor(() => {
      expect(screen.getByText('day trading')).toBeInTheDocument();
    });
    expect(screen.getByText('ETHUSDT')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
  });

  it('shows error for failed jobs in expanded view', async () => {
    mockFetchResponse([mockCompletedRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByLabelText('Expand row')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Expand row'));

    await waitFor(() => {
      expect(screen.getByText('Binance API 403')).toBeInTheDocument();
    });
  });

  it('collapses expanded row on second click', async () => {
    mockFetchResponse([mockCompletedRun]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByLabelText('Expand row')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Expand row'));
    await waitFor(() => {
      expect(screen.getByText('scalping')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Collapse row'));
    await waitFor(() => {
      expect(screen.queryByText('scalping')).not.toBeInTheDocument();
    });
  });
});
