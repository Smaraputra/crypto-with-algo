import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveCandles, niceTicks } from './LiveCandles';
import type { CombinedFrame } from '@/lib/market-stream/client';

let capturedOnFrame: ((frame: CombinedFrame) => void) | null = null;

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStream: vi.fn((_streams, onFrame) => {
    capturedOnFrame = onFrame;
  }),
}));

vi.mock('@/lib/chart-theme', () => ({
  useChartTheme: () => ({
    grid: '#24272D',
    crosshair: '#7C8490',
    up: '#00C57C',
    down: '#FF6B7A',
    volume: '#1F2227',
    text: '#FFFFFF',
    mutedText: '#6B727D',
    line: '#24272D',
    accentLine: '#00C57C',
  }),
}));

const START_TIME = 1700000000000;

function create48Bars(base = 65000) {
  return Array.from({ length: 48 }, (_, i) => ({
    t: START_TIME + i * 3600000,
    o: base + i * 10,
    h: base + i * 10 + 50,
    l: base + i * 10 - 50,
    c: base + i * 10 + 20,
    v: 100 + i,
  }));
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 60_000,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe('LiveCandles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnFrame = null;
  });

  it('48 bars render as 48 candle groups', async () => {
    const bars = create48Bars(65000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => bars,
    } as Response);

    const { container } = renderWithClient(<LiveCandles />);

    await waitFor(() => {
      const groups = container.querySelectorAll('[data-testid="candle-group"]');
      expect(groups).toHaveLength(48);
    });
  });

  it('a frame with the last t changes the last close label', async () => {
    const bars = create48Bars(65000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => bars,
    } as Response);

    renderWithClient(<LiveCandles />);

    await waitFor(() => {
      expect(screen.getByTestId('last-close-label')).toBeInTheDocument();
    });

    const lastBar = bars[47];
    expect(screen.getByTestId('last-close-label')).toHaveTextContent(
      `$${(lastBar.c).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
    );

    // Stream update on the forming bar
    act(() => {
      capturedOnFrame?.({
        stream: 'btcusdt@kline_1h',
        data: {
          k: {
            t: lastBar.t,
            o: lastBar.o,
            h: 70000,
            l: 64000,
            c: 69999,
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('last-close-label')).toHaveTextContent('$69,999.00');
    });
  });

  it('a frame with a new t keeps 48 bars and the last label updates', async () => {
    const bars = create48Bars(65000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => bars,
    } as Response);

    const { container } = renderWithClient(<LiveCandles />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="candle-group"]')).toHaveLength(48);
    });

    const lastBar = bars[47];
    const newBarTime = lastBar.t + 3600000;

    act(() => {
      capturedOnFrame?.({
        stream: 'btcusdt@kline_1h',
        data: {
          k: {
            t: newBarTime,
            o: 70000,
            h: 71000,
            l: 69500,
            c: 70500,
          },
        },
      });
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="candle-group"]')).toHaveLength(48);
      expect(screen.getByTestId('last-close-label')).toHaveTextContent('$70,500.00');
    });
  });

  it('switching to ETH requests symbol=ETHUSDT', async () => {
    const btcBars = create48Bars(65000);
    const ethBars = create48Bars(3500);

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('symbol=ETHUSDT')) {
        return Promise.resolve({
          ok: true,
          json: async () => ethBars,
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => btcBars,
      } as Response);
    });

    renderWithClient(<LiveCandles />);

    await waitFor(() => {
      expect(screen.getByTestId('last-close-label')).toBeInTheDocument();
    });

    const ethOption = screen.getByLabelText('ETH');
    fireEvent.click(ethOption);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('symbol=ETHUSDT')
      );
    });
  });

  it('the error state and retry', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
    } as Response);

    renderWithClient(<LiveCandles />);

    await waitFor(() => {
      expect(screen.getByText('Market data did not load.')).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole('button', { name: 'Try again' });
    expect(retryBtn).toBeInTheDocument();

    const bars = create48Bars(65000);
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => bars,
    } as Response);

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByText('Market data did not load.')).not.toBeInTheDocument();
    });
  });

  it('the aria-label includes the last price', async () => {
    const bars = create48Bars(65000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => bars,
    } as Response);

    renderWithClient(<LiveCandles />);

    await waitFor(() => {
      const img = screen.getByRole('img');
      const lastBar = bars[47];
      const lastPriceFormatted = `$${lastBar.c.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      expect(img).toHaveAttribute(
        'aria-label',
        expect.stringContaining(lastPriceFormatted)
      );
    });
  });
});

describe('niceTicks', () => {
  it('returns round prices on a 1, 2 or 5 step inside the range', () => {
    expect(niceTicks(80650, 82760, 4)).toEqual([81000, 81500, 82000, 82500]);
    expect(niceTicks(2300, 2410, 4)).toEqual([2300, 2320, 2340, 2360, 2380, 2400]);
  });

  it('returns nothing for an empty range', () => {
    expect(niceTicks(5, 5, 4)).toEqual([]);
  });
});
