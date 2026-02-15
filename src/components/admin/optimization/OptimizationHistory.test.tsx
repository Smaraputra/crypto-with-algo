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

const mockCompletedJob = {
  id: 'job-1',
  tradingStyle: 'day_trading',
  symbol: 'BTCUSDT',
  interval: '1h',
  status: 'completed' as const,
  templateVersion: 2,
  startedAt: '2025-02-01T10:00:00.000Z',
  completedAt: '2025-02-01T10:02:30.000Z',
  createdAt: '2025-02-01T10:00:00.000Z',
  progress: {
    candidatesTested: 250,
    validResults: 18,
  },
};

const mockRunningJob = {
  id: 'job-2',
  tradingStyle: 'scalping',
  symbol: 'ETHUSDT',
  interval: '5m',
  status: 'running' as const,
  templateVersion: null,
  startedAt: '2025-02-15T10:00:00.000Z',
  completedAt: null,
  createdAt: '2025-02-15T10:00:00.000Z',
  progress: {
    candidatesTested: 50,
    validResults: 3,
  },
};

const mockFailedJob = {
  id: 'job-3',
  tradingStyle: 'swing_trading',
  symbol: 'BTCUSDT',
  interval: '4h',
  status: 'failed' as const,
  templateVersion: null,
  startedAt: '2025-02-10T10:00:00.000Z',
  completedAt: '2025-02-10T10:00:30.000Z',
  createdAt: '2025-02-10T10:00:00.000Z',
  progress: {
    candidatesTested: 10,
    validResults: 0,
  },
};

const mockPendingJob = {
  id: 'job-4',
  tradingStyle: 'position_trading',
  symbol: 'BTCUSDT',
  interval: '1d',
  status: 'pending' as const,
  templateVersion: null,
  startedAt: null,
  completedAt: null,
  createdAt: '2025-02-20T10:00:00.000Z',
  progress: {
    candidatesTested: 0,
    validResults: 0,
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('OptimizationHistory', () => {
  const defaultProps = {
    onViewComparison: vi.fn(),
  };

  async function renderComponent(props = defaultProps) {
    const { OptimizationHistory } = await import('./OptimizationHistory');
    return render(
      React.createElement(OptimizationHistory, props),
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
      expect(screen.getByText(/Failed to load optimization history/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when no jobs exist', async () => {
    mockFetchResponse([]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('No optimization jobs yet')).toBeInTheDocument();
    });
    expect(screen.getByText('Start your first optimization to see it here')).toBeInTheDocument();
  });

  it('renders table with correct headers', async () => {
    mockFetchResponse([mockCompletedJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Date')).toBeInTheDocument();
    });
    expect(screen.getByText('Style')).toBeInTheDocument();
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Interval')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Tested')).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('renders card title and description', async () => {
    mockFetchResponse([]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Optimization History')).toBeInTheDocument();
    });
    expect(screen.getByText('View past and ongoing optimization jobs')).toBeInTheDocument();
  });

  it('renders job row with correct data', async () => {
    mockFetchResponse([mockCompletedJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Feb 1, 2025')).toBeInTheDocument();
    });
    expect(screen.getByText('day trading')).toBeInTheDocument();
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('shows duration for completed jobs', async () => {
    mockFetchResponse([mockCompletedJob]);
    await renderComponent();
    await waitFor(() => {
      // 2m 30s = 150 seconds
      expect(screen.getByText('150s')).toBeInTheDocument();
    });
  });

  it('shows "Running..." for running jobs', async () => {
    mockFetchResponse([mockRunningJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('Running...')).toBeInTheDocument();
    });
  });

  it('shows dash for pending jobs duration', async () => {
    mockFetchResponse([mockPendingJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('-')).toBeInTheDocument();
    });
  });

  it('shows Compare button for completed jobs with templateVersion', async () => {
    mockFetchResponse([mockCompletedJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Compare/i })).toBeInTheDocument();
    });
  });

  it('calls onViewComparison when Compare button is clicked', async () => {
    const onViewComparison = vi.fn();
    mockFetchResponse([mockCompletedJob]);
    await renderComponent({ onViewComparison });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Compare/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }));
    expect(onViewComparison).toHaveBeenCalledWith('job-1');
  });

  it('does not show Compare button for running jobs', async () => {
    mockFetchResponse([mockRunningJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('running')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Compare/i })).not.toBeInTheDocument();
  });

  it('does not show Compare button for failed jobs', async () => {
    mockFetchResponse([mockFailedJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('failed')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Compare/i })).not.toBeInTheDocument();
  });

  it('renders multiple job rows', async () => {
    mockFetchResponse([mockCompletedJob, mockRunningJob, mockFailedJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument();
    });
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('displays trading style with underscores replaced by spaces', async () => {
    mockFetchResponse([mockCompletedJob]);
    await renderComponent();
    await waitFor(() => {
      expect(screen.getByText('day trading')).toBeInTheDocument();
    });
  });

  it('shows time on second line of date cell', async () => {
    mockFetchResponse([mockCompletedJob]);
    await renderComponent();
    await waitFor(() => {
      // Time is formatted with h:mm a pattern -- actual value depends on timezone
      // Just verify there's a time-like element in the date cell
      const dateCell = screen.getByText('Feb 1, 2025').closest('td');
      expect(dateCell).toBeTruthy();
      // The time span should contain AM or PM
      const timeSpan = dateCell!.querySelector('.text-muted-foreground');
      expect(timeSpan).toBeTruthy();
      expect(timeSpan!.textContent).toMatch(/\d+:\d+ [AP]M/);
    });
  });
});
