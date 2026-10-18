// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMarketStream, useMarketStreamStatus } from './useMarketStream';
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

describe('useMarketStream hooks', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    MockEventSource.resetMock();
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

  describe('useMarketStreamStatus', () => {
    it('starts connecting with isConnected false, becomes live after subscribe and open, and sets lastMessageAt on frame', () => {
      const { result } = renderHook(() => useMarketStreamStatus());

      expect(result.current.status).toBe('connecting');
      expect(result.current.isConnected).toBe(false);
      expect(result.current.lastMessageAt).toBeNull();

      act(() => {
        clientHolder.current!.subscribe(['btcusdt@ticker'], vi.fn());
      });

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(1);

      act(() => {
        MockEventSource.lastInstance?.simulateOpen();
      });

      expect(result.current.status).toBe('live');
      expect(result.current.isConnected).toBe(true);

      act(() => {
        MockEventSource.lastInstance?.simulateMessage({
          stream: 'btcusdt@ticker',
          data: { c: '100' },
        });
      });

      expect(result.current.lastMessageAt).not.toBeNull();
      expect(typeof result.current.lastMessageAt).toBe('number');
    });

    it('opens a new source when retry() is called', () => {
      act(() => {
        clientHolder.current!.subscribe(['btcusdt@ticker'], vi.fn());
      });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      act(() => {
        MockEventSource.lastInstance?.simulateOpen();
      });
      expect(MockEventSource.instances).toHaveLength(1);

      const { result } = renderHook(() => useMarketStreamStatus());

      act(() => {
        result.current.retry();
      });

      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[0].closed).toBe(true);
    });
  });

  describe('useMarketStream', () => {
    it('calls onFrame with frame and does not open new source when re-rendered with new array of same names', () => {
      const onFrame = vi.fn();
      const { rerender } = renderHook(
        ({ streams }) => useMarketStream(streams, onFrame),
        { initialProps: { streams: ['btcusdt@ticker'] } }
      );

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(1);
      const source = MockEventSource.lastInstance!;
      act(() => {
        source.simulateOpen();
      });

      const frame = { stream: 'btcusdt@ticker', data: { c: '100' } };
      act(() => {
        source.simulateMessage(frame);
      });

      expect(onFrame).toHaveBeenCalledTimes(1);
      expect(onFrame).toHaveBeenCalledWith(frame);

      // Re-render with new array of same names
      rerender({ streams: ['btcusdt@ticker'] });
      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('reopens with that stream when names change and unmount unsubscribes', () => {
      const onFrame = vi.fn();
      const { rerender, unmount } = renderHook(
        ({ streams }) => useMarketStream(streams, onFrame),
        { initialProps: { streams: ['btcusdt@ticker'] } }
      );

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.lastInstance?.url).toBe('/api/stream?streams=btcusdt@ticker');

      rerender({ streams: ['ethusdt@ticker'] });
      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[0].closed).toBe(true);
      expect(MockEventSource.lastInstance?.url).toBe('/api/stream?streams=ethusdt@ticker');

      unmount();
      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances[1].closed).toBe(true);
      expect(MockEventSource.instances).toHaveLength(2);
    });

    it('routes next frame to new function only when re-rendered with different onFrame', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const { rerender } = renderHook(
        ({ onFrame }) => useMarketStream(['btcusdt@ticker'], onFrame),
        { initialProps: { onFrame: fn1 } }
      );

      act(() => {
        vi.advanceTimersByTime(250);
      });
      act(() => {
        MockEventSource.lastInstance?.simulateOpen();
      });

      rerender({ onFrame: fn2 });

      const frame = { stream: 'btcusdt@ticker', data: { c: '200' } };
      act(() => {
        MockEventSource.lastInstance?.simulateMessage(frame);
      });

      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledWith(frame);
    });

    it('opens nothing when streams list is empty', () => {
      const onFrame = vi.fn();
      renderHook(() => useMarketStream([], onFrame));

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(0);
    });
  });
});
