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

describe('DataStatus', () => {
  it('renders with symbol and interval', () => {
    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByTestId('data-status')).toBeInTheDocument();
    expect(screen.getByText('BTCUSDT / 1h')).toBeInTheDocument();
  });

  it('renders Historical Data title', () => {
    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByText('Historical Data')).toBeInTheDocument();
  });

  it('shows Check Status button initially', () => {
    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByText('Check Status')).toBeInTheDocument();
  });

  it('shows candle count after checking status', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          candles: [{ timestamp: 1700000000000 }],
          count: 1,
        }),
    });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    fireEvent.click(screen.getByText('Check Status'));

    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  it('shows backfill button after status check', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          candles: [],
          count: 0,
        }),
    });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    fireEvent.click(screen.getByText('Check Status'));

    await waitFor(() => {
      expect(screen.getByTestId('backfill-button')).toBeInTheDocument();
    });
  });

  it('shows no data message when count is 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          candles: [],
          count: 0,
        }),
    });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    fireEvent.click(screen.getByText('Check Status'));

    await waitFor(() => {
      expect(
        screen.getByText('No historical data stored yet.')
      ).toBeInTheDocument();
    });
  });

  it('triggers backfill on button click', async () => {
    // First call: check status
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ candles: [], count: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ candles: [], count: 0 }),
      })
      // Backfill call
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            inserted: 17520,
            total: 17520,
            oldest: 1600000000000,
            newest: 1700000000000,
          }),
      });

    render(<DataStatus symbol="BTCUSDT" interval="1h" />);
    fireEvent.click(screen.getByText('Check Status'));

    await waitFor(() => {
      expect(screen.getByTestId('backfill-button')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('backfill-button'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/candles/backfill',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});
