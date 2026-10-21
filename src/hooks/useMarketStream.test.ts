// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMarketStream, useMarketStreamStatus } from './useMarketStream';
import { MockEventSource } from '@/test/mock-event-source';
import type { MarketStreamClient } from '@/lib/market-stream/client';

const { spotClientHolder, perpClientHolder } = vi.hoisted(() => ({
  spotClientHolder: { current: null as MarketStreamClient | null },
  perpClientHolder: { current: null as MarketStreamClient | null },
}));
const clientHolder = spotClientHolder;

vi.mock('@/lib/market-stream/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/market-stream/client')>(
    '@/lib/market-stream/client'
  );
  return {
    ...actual,
    getMarketStreamClient: () => spotClientHolder.current!,
    getPerpMarketStreamClient: () => perpClientHolder.current!,
    getStreamClient: (market: 'spot' | 'perp') =>
      market === 'perp' ? perpClientHolder.current! : spotClientHolder.current!,
  };
});

describe('useMarketStream hooks', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    MockEventSource.resetMock();
    const actual = await vi.importActual<typeof import('@/lib/market-stream/client')>(
      '@/lib/market-stream/client'
    );
    spotClientHolder.current = actual.createMarketStreamClient({
      url: '/api/stream',
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
      random: () => 1,
    });
    perpClientHolder.current = actual.createMarketStreamClient({
      url: '/api/stream/perp',
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
      random: () => 1,
    });
  });

  afterEach(() => {
    spotClientHolder.current?.dispose();
    perpClientHolder.current?.dispose();
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

    it("reflects the perp client's snapshot with useMarketStreamStatus('perp') and retry calls perp client retry", () => {
      const { result } = renderHook(() => useMarketStreamStatus('perp'));

      expect(result.current.status).toBe('connecting');
      expect(result.current.isConnected).toBe(false);
      expect(result.current.lastMessageAt).toBeNull();

      act(() => {
        perpClientHolder.current!.subscribe(['btcusdt@ticker'], vi.fn());
      });
      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.lastInstance?.url).toContain('/api/stream/perp');

      act(() => {
        MockEventSource.lastInstance?.simulateOpen();
      });

      expect(result.current.status).toBe('live');
      expect(result.current.isConnected).toBe(true);

      act(() => {
        result.current.retry();
      });

      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[0].closed).toBe(true);
      expect(MockEventSource.instances[1].url).toContain('/api/stream/perp');
    });

    it('isolates spot and perp market streams from each other', () => {
      const spotHook = renderHook(() => useMarketStreamStatus());
      const perpHook = renderHook(() => useMarketStreamStatus('perp'));

      expect(spotHook.result.current.status).toBe('connecting');
      expect(perpHook.result.current.status).toBe('connecting');

      act(() => {
        perpClientHolder.current!.subscribe(['btcusdt@ticker'], vi.fn());
      });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      act(() => {
        MockEventSource.lastInstance?.simulateOpen();
      });

      expect(perpHook.result.current.status).toBe('live');
      expect(spotHook.result.current.status).toBe('connecting');
    });
  });

  describe('useMarketStream', () => {
    it('subscribes on the perp client when market is perp', () => {
      const onFrame = vi.fn();
      renderHook(() => useMarketStream(['btcusdt@ticker'], onFrame, 'perp'));

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.lastInstance?.url).toBe('/api/stream/perp?streams=btcusdt@ticker');
    });
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
