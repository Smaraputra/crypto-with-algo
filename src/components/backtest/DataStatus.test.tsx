import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DataStatus } from './DataStatus';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

function mockRangeResponse(data: { oldest: number | null; newest: number | null; count: number }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

describe('DataStatus', () => {
  it('renders with symbol and interval', async () => {
    mockRangeResponse({ oldest: null, newest: null, count: 0 });
    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByTestId('data-status')).toBeInTheDocument();
    expect(screen.getByText('BTCUSDT / 1h')).toBeInTheDocument();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });

  it('renders Historical Data title', async () => {
    mockRangeResponse({ oldest: null, newest: null, count: 0 });
    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByText('Historical Data')).toBeInTheDocument();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });

  it('auto-fetches range on mount', async () => {
    mockRangeResponse({ oldest: 1700000000000, newest: 1700100000000, count: 500 });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/candles/range?symbol=BTCUSDT&interval=1h'
      );
    });
  });

  it('shows candle count after auto-fetch', async () => {
    mockRangeResponse({ oldest: 1700000000000, newest: 1700100000000, count: 17520 });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);

    await waitFor(() => {
      expect(screen.getByText('17,520')).toBeInTheDocument();
    });
  });

  it('shows backfill button after loading completes', async () => {
    mockRangeResponse({ oldest: null, newest: null, count: 0 });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);

    await waitFor(() => {
      expect(screen.getByTestId('backfill-button')).toBeInTheDocument();
    });
  });

  it('shows no data message when count is 0', async () => {
    mockRangeResponse({ oldest: null, newest: null, count: 0 });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);

    await waitFor(() => {
      expect(
        screen.getByText('No historical data stored yet.')
      ).toBeInTheDocument();
    });
  });

  it('renders in compact mode without card wrapper', async () => {
    mockRangeResponse({ oldest: null, newest: null, count: 0 });
    render(<DataStatus symbol="BTCUSDT" interval="1h" compact />);
    expect(screen.getByTestId('data-status')).toBeInTheDocument();
    expect(screen.queryByText('Historical Data')).not.toBeInTheDocument();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });

  it('triggers backfill on button click', async () => {
    // Auto-fetch response
    mockRangeResponse({ oldest: null, newest: null, count: 0 });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);

    await waitFor(() => {
      expect(screen.getByTestId('backfill-button')).toBeInTheDocument();
    });

    // Backfill response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          inserted: 17520,
          total: 17520,
          oldest: 1600000000000,
          newest: 1700000000000,
        }),
    });

    fireEvent.click(screen.getByTestId('backfill-button'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/candles/backfill',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('re-fetches when interval changes', async () => {
    mockRangeResponse({ oldest: null, newest: null, count: 0 });

    const { rerender } = render(<DataStatus symbol="BTCUSDT" interval="1h" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/candles/range?symbol=BTCUSDT&interval=1h'
      );
    });

    mockRangeResponse({ oldest: null, newest: null, count: 100 });

    rerender(<DataStatus symbol="BTCUSDT" interval="4h" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/candles/range?symbol=BTCUSDT&interval=4h'
      );
    });
  });

  it('re-fetches when symbol changes', async () => {
    mockRangeResponse({ oldest: null, newest: null, count: 0 });

    const { rerender } = render(<DataStatus symbol="BTCUSDT" interval="1h" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/candles/range?symbol=BTCUSDT&interval=1h'
      );
    });

    mockRangeResponse({ oldest: null, newest: null, count: 200 });

    rerender(<DataStatus symbol="ETHUSDT" interval="1h" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/candles/range?symbol=ETHUSDT&interval=1h'
      );
    });
  });
});
