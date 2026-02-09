import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let mockWorkerInstance: {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
};

// Create a proper constructor mock
function MockWorker() {
  const instance = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
  };
  mockWorkerInstance = instance;
  return instance;
}
vi.stubGlobal('Worker', MockWorker);

import { useBacktest } from './useBacktest';

beforeEach(() => {
  vi.clearAllMocks();
});

const mockCandles = [
  { timestamp: 1704067200000, open: 42000, high: 42500, low: 41800, close: 42200, volume: 100 },
];

const mockConfig = {
  entryThreshold: 30,
  exitThreshold: -10,
  shortEntryThreshold: -30,
  shortExitThreshold: 10,
  stopLossPercent: 0.05,
  takeProfitPercent: 0.10,
  positionSizePercent: 0.10,
  allowShorts: false,
  feePercent: 0.001,
  weights: { trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10 },
  startEquity: 10000,
};

describe('useBacktest', () => {
  it('starts with idle status', () => {
    const { result } = renderHook(() => useBacktest());
    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toBe(0);
    expect(result.current.result).toBeNull();
  });

  it('sets status to running when run is called', () => {
    const { result } = renderHook(() => useBacktest());

    act(() => {
      result.current.run(mockCandles, mockConfig, 'BTCUSDT', '1h');
    });

    expect(result.current.status).toBe('running');
    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run',
        symbol: 'BTCUSDT',
        interval: '1h',
      })
    );
  });

  it('updates progress on worker progress message', () => {
    const { result } = renderHook(() => useBacktest());

    act(() => {
      result.current.run(mockCandles, mockConfig, 'BTCUSDT', '1h');
    });

    act(() => {
      mockWorkerInstance.onmessage?.({
        data: { type: 'progress', progress: 50, barsProcessed: 150, totalBars: 300 },
      } as MessageEvent);
    });

    expect(result.current.progress).toBe(50);
    expect(result.current.barsProcessed).toBe(150);
    expect(result.current.totalBars).toBe(300);
  });

  it('sets result on worker complete message', () => {
    const { result } = renderHook(() => useBacktest());
    const mockResult = { metrics: {}, trades: [], equityCurve: [] };

    act(() => {
      result.current.run(mockCandles, mockConfig, 'BTCUSDT', '1h');
    });

    act(() => {
      mockWorkerInstance.onmessage?.({
        data: { type: 'complete', result: mockResult },
      } as MessageEvent);
    });

    expect(result.current.status).toBe('complete');
    expect(result.current.result).toBe(mockResult);
    expect(result.current.progress).toBe(100);
  });

  it('sets error on worker error message', () => {
    const { result } = renderHook(() => useBacktest());

    act(() => {
      result.current.run(mockCandles, mockConfig, 'BTCUSDT', '1h');
    });

    act(() => {
      mockWorkerInstance.onmessage?.({
        data: { type: 'error', message: 'Something went wrong' },
      } as MessageEvent);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('Something went wrong');
  });

  it('cancels running backtest', () => {
    const { result } = renderHook(() => useBacktest());

    act(() => {
      result.current.run(mockCandles, mockConfig, 'BTCUSDT', '1h');
    });

    act(() => {
      result.current.cancel();
    });

    expect(result.current.status).toBe('idle');
    expect(mockWorkerInstance.terminate).toHaveBeenCalled();
  });
});
