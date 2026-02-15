import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const mockRunningJob = {
  job: {
    id: 'job-1',
    tradingStyle: 'day_trading',
    symbol: 'BTCUSDT',
    interval: '1h',
    status: 'running' as const,
    error: null,
    optimizedWeights: null,
    templateVersion: null,
    startedAt: '2025-02-01T10:00:00.000Z',
    completedAt: null,
    createdAt: '2025-02-01T10:00:00.000Z',
  },
  progress: {
    percent: 45,
    currentWindow: 3,
    totalWindows: 6,
    candidatesTested: 150,
    validResults: 12,
    estimatedTimeRemaining: 120,
  },
};

const mockCompletedJob = {
  job: {
    id: 'job-2',
    tradingStyle: 'swing_trading',
    symbol: 'ETHUSDT',
    interval: '4h',
    status: 'completed' as const,
    error: null,
    optimizedWeights: { trend: 0.3, momentum: 0.25, volume: 0.15, volatility: 0.1, futures: 0.1, sentiment: 0.1 },
    templateVersion: 3,
    startedAt: '2025-02-01T10:00:00.000Z',
    completedAt: '2025-02-01T10:05:00.000Z',
    createdAt: '2025-02-01T10:00:00.000Z',
  },
  progress: {
    percent: 100,
    currentWindow: 6,
    totalWindows: 6,
    candidatesTested: 300,
    validResults: 25,
    estimatedTimeRemaining: 0,
  },
};

const mockFailedJob = {
  job: {
    id: 'job-3',
    tradingStyle: 'scalping',
    symbol: 'BTCUSDT',
    interval: '1m',
    status: 'failed' as const,
    error: 'Insufficient historical data',
    optimizedWeights: null,
    templateVersion: null,
    startedAt: '2025-02-01T10:00:00.000Z',
    completedAt: '2025-02-01T10:01:00.000Z',
    createdAt: '2025-02-01T10:00:00.000Z',
  },
  progress: {
    percent: 10,
    currentWindow: 1,
    totalWindows: 6,
    candidatesTested: 30,
    validResults: 0,
    estimatedTimeRemaining: 0,
  },
};

const mockPendingJob = {
  job: {
    id: 'job-4',
    tradingStyle: 'position_trading',
    symbol: 'BTCUSDT',
    interval: '1d',
    status: 'pending' as const,
    error: null,
    optimizedWeights: null,
    templateVersion: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2025-02-01T10:00:00.000Z',
  },
  progress: {
    percent: 0,
    currentWindow: 0,
    totalWindows: 0,
    candidatesTested: 0,
    validResults: 0,
    estimatedTimeRemaining: 0,
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('OptimizationProgress', () => {
  const defaultProps = {
    jobId: 'job-1',
    onComplete: vi.fn(),
  };

  async function renderComponent(props = defaultProps) {
    const { OptimizationProgress } = await import('./OptimizationProgress');
    return render(
      React.createElement(OptimizationProgress, props),
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
      expect(screen.getByText(/Failed to load optimization status/i)).toBeInTheDocument();
    });
  });

  it('fetches job status from correct API endpoint', async () => {
    const fetchSpy = mockFetchResponse(mockRunningJob);
    await renderComponent();
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/admin/optimize-template/job-1');
    });
  });

  it('displays running state with progress bar and stats', async () => {
    mockFetchResponse(mockRunningJob);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Optimization In Progress')).toBeInTheDocument();
    });
    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
  });

  it('shows progress stats for running job', async () => {
    mockFetchResponse(mockRunningJob);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('3 / 6')).toBeInTheDocument();
    });
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('shows estimated time remaining for running job', async () => {
    mockFetchResponse(mockRunningJob);
    await renderComponent();
    await waitFor(() => {
      // 120 seconds = ~2 minutes
      expect(screen.getByText('~2m')).toBeInTheDocument();
    });
  });

  it('shows "Calculating..." when estimated time is 0 and still running', async () => {
    const jobWithZeroTime = {
      ...mockRunningJob,
      progress: { ...mockRunningJob.progress, estimatedTimeRemaining: 0 },
    };
    mockFetchResponse(jobWithZeroTime);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Calculating...')).toBeInTheDocument();
    });
  });

  it('displays trading style, symbol, and interval', async () => {
    mockFetchResponse(mockRunningJob);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/day trading/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/BTCUSDT/)).toBeInTheDocument();
    expect(screen.getByText(/1h/)).toBeInTheDocument();
  });

  it('displays completed state with success alert', async () => {
    mockFetchResponse(mockCompletedJob);
    await renderComponent({ ...defaultProps, jobId: 'job-2' });
    await waitFor(() => {
      expect(screen.getByText('Optimization Completed')).toBeInTheDocument();
    });
    expect(screen.getByText('Optimization Successful')).toBeInTheDocument();
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
  });

  it('shows template version for completed job', async () => {
    mockFetchResponse(mockCompletedJob);
    await renderComponent({ ...defaultProps, jobId: 'job-2' });
    await waitFor(() => {
      expect(screen.getByText(/Created template version 3/)).toBeInTheDocument();
    });
  });

  it('shows candidates tested and valid results for completed job', async () => {
    mockFetchResponse(mockCompletedJob);
    await renderComponent({ ...defaultProps, jobId: 'job-2' });
    await waitFor(() => {
      expect(screen.getByText(/Tested 300 weight combinations, 25 passed robustness filters/)).toBeInTheDocument();
    });
  });

  it('displays failed state with error message', async () => {
    mockFetchResponse(mockFailedJob);
    await renderComponent({ ...defaultProps, jobId: 'job-3' });
    await waitFor(() => {
      // Title says "Optimization Failed" and alert also says "Optimization Failed"
      const failedElements = screen.getAllByText('Optimization Failed');
      expect(failedElements.length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('Insufficient historical data')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
  });

  it('displays pending state', async () => {
    mockFetchResponse(mockPendingJob);
    await renderComponent({ ...defaultProps, jobId: 'job-4' });
    await waitFor(() => {
      expect(screen.getByText('Optimization Pending')).toBeInTheDocument();
    });
    expect(screen.getByText('PENDING')).toBeInTheDocument();
  });

  it('shows "Started" timestamp when startedAt is available', async () => {
    mockFetchResponse(mockRunningJob);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Started/)).toBeInTheDocument();
    });
  });

  it('does not show "Started" text when startedAt is null', async () => {
    mockFetchResponse(mockPendingJob);
    await renderComponent({ ...defaultProps, jobId: 'job-4' });
    await waitFor(() => {
      expect(screen.getByText('Optimization Pending')).toBeInTheDocument();
    });
    // The "Started" line at the bottom should not appear
    const startedElements = screen.queryAllByText(/^Started/);
    expect(startedElements.length).toBe(0);
  });
});
