// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBinanceTicker } from './useBinanceStream';
import { MockEventSource } from '@/test/mock-event-source';
import type { MarketStreamClient } from '@/lib/market-stream/client';

const { clientHolder } = vi.hoisted(() => ({
  clientHolder: { current: null as MarketStreamClient | null },
}));

vi.mock('@/lib/market-stream/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/market-stream/client')>(
    '@/lib/market-stream/client'
  );
  return {
    ...actual,
    getMarketStreamClient: () => clientHolder.current!,
  };
});

describe('useBinanceTicker', () => {
  let rafCallbacks: Array<FrameRequestCallback> = [];
  let rafId = 0;

  beforeEach(async () => {
    vi.useFakeTimers();
    MockEventSource.resetMock();
    rafCallbacks = [];
    rafId = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return ++rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const actual = await vi.importActual<typeof import('@/lib/market-stream/client')>(
      '@/lib/market-stream/client'
    );
    clientHolder.current = actual.createMarketStreamClient({
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
      random: () => 1,
    });
  });

  afterEach(() => {
    clientHolder.current?.dispose();
    MockEventSource.resetMock();
    vi.useRealTimers();
  });

  function flushRaf() {
    act(() => {
      for (const cb of rafCallbacks) cb(0);
      rafCallbacks = [];
    });
  }

  it('subscribes with correct combined stream URL', () => {
    renderHook(() => useBinanceTicker(['BTCUSDT', 'ETHUSDT']));

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(MockEventSource.lastInstance?.url).toBe(
      '/api/stream?streams=btcusdt@ticker/ethusdt@ticker'
    );
  });

  it('opens nothing and isConnected is false for empty symbols array', () => {
    const { result } = renderHook(() => useBinanceTicker([]));

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.isConnected).toBe(false);
  });

  it('updates tickers from message after rAF flush', () => {
    const { result } = renderHook(() => useBinanceTicker(['BTCUSDT']));

    act(() => {
      vi.advanceTimersByTime(250);
    });
    act(() => {
      MockEventSource.lastInstance?.simulateOpen();
    });

    act(() => {
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'BTCUSDT',
          c: '100',
          p: '1',
          P: '1',
          o: '99',
          h: '101',
          l: '98',
          v: '10',
          q: '1000',
          n: 5,
        },
      });
    });

    expect(result.current.tickers['BTCUSDT']).toBeUndefined();

    flushRaf();

    expect(result.current.tickers['BTCUSDT']).toEqual({
      symbol: 'BTCUSDT',
      lastPrice: '100',
      priceChange: '1',
      priceChangePercent: '1',
      openPrice: '99',
      highPrice: '101',
      lowPrice: '98',
      volume: '10',
      quoteVolume: '1000',
      count: 5,
    });
  });

  it('handles multiple symbols updating independently', () => {
    const { result } = renderHook(() => useBinanceTicker(['BTCUSDT', 'ETHUSDT']));

    act(() => {
      vi.advanceTimersByTime(250);
    });
    act(() => {
      MockEventSource.lastInstance?.simulateOpen();
    });

    act(() => {
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'BTCUSDT',
          c: '40500',
          p: '500',
          P: '1.25',
          o: '40000',
          h: '41000',
          l: '39500',
          v: '1000',
          q: '40500000',
          n: 50000,
        },
      });
    });

    flushRaf();
    expect(result.current.tickers['BTCUSDT'].lastPrice).toBe('40500');
    expect(result.current.tickers['ETHUSDT']).toBeUndefined();

    act(() => {
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'ethusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'ETHUSDT',
          c: '2550',
          p: '50',
          P: '2.00',
          o: '2500',
          h: '2600',
          l: '2450',
          v: '5000',
          q: '12750000',
          n: 30000,
        },
      });
    });

    flushRaf();
    expect(result.current.tickers['BTCUSDT'].lastPrice).toBe('40500');
    expect(result.current.tickers['ETHUSDT'].lastPrice).toBe('2550');
  });

  it('batches several rapid frames into one state update', () => {
    const { result } = renderHook(() => useBinanceTicker(['BTCUSDT', 'ETHUSDT']));

    act(() => {
      vi.advanceTimersByTime(250);
    });
    act(() => {
      MockEventSource.lastInstance?.simulateOpen();
    });

    act(() => {
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'BTCUSDT',
          c: '40500',
          p: '500',
          P: '1.25',
          o: '40000',
          h: '41000',
          l: '39500',
          v: '1000',
          q: '40500000',
          n: 50000,
        },
      });
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'ethusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'ETHUSDT',
          c: '2550',
          p: '50',
          P: '2.00',
          o: '2500',
          h: '2600',
          l: '2450',
          v: '5000',
          q: '12750000',
          n: 30000,
        },
      });
    });

    expect(rafCallbacks).toHaveLength(1);

    flushRaf();

    expect(result.current.tickers['BTCUSDT'].lastPrice).toBe('40500');
    expect(result.current.tickers['ETHUSDT'].lastPrice).toBe('2550');
  });

  it('tracks isConnected with client status and returns status, lastMessageAt, retry', () => {
    const { result } = renderHook(() => useBinanceTicker(['BTCUSDT']));

    expect(result.current.status).toBe('connecting');
    expect(result.current.isConnected).toBe(false);
    expect(result.current.lastMessageAt).toBeNull();
    expect(typeof result.current.retry).toBe('function');

    act(() => {
      vi.advanceTimersByTime(250);
    });
    act(() => {
      MockEventSource.lastInstance?.simulateOpen();
    });

    expect(result.current.status).toBe('live');
    expect(result.current.isConnected).toBe(true);

    act(() => {
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'BTCUSDT',
          c: '100',
          p: '1',
          P: '1',
          o: '99',
          h: '101',
          l: '98',
          v: '10',
          q: '1000',
          n: 5,
        },
      });
    });

    flushRaf();

    expect(result.current.lastMessageAt).not.toBeNull();

    const prevCount = MockEventSource.instances.length;
    act(() => {
      result.current.retry();
    });
    expect(MockEventSource.instances).toHaveLength(prevCount + 1);
  });

  it('ignores frame whose data has no string s', () => {
    const { result } = renderHook(() => useBinanceTicker(['BTCUSDT']));

    act(() => {
      vi.advanceTimersByTime(250);
    });
    act(() => {
      MockEventSource.lastInstance?.simulateOpen();
    });

    act(() => {
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          c: '100',
        },
      });
    });

    flushRaf();
    expect(result.current.tickers).toEqual({});
  });

  it('cancels pending animation frame on unmount', () => {
    const cancelSpy = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelSpy);

    const { unmount } = renderHook(() => useBinanceTicker(['BTCUSDT']));

    act(() => {
      vi.advanceTimersByTime(250);
    });
    act(() => {
      MockEventSource.lastInstance?.simulateOpen();
    });

    act(() => {
      MockEventSource.lastInstance?.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'BTCUSDT',
          c: '100',
          p: '1',
          P: '1',
          o: '99',
          h: '101',
          l: '98',
          v: '10',
          q: '1000',
          n: 5,
        },
      });
    });

    expect(rafCallbacks).toHaveLength(1);
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
