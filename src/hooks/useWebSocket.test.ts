import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MockWebSocket } from '@/test/mock-websocket';
import { useWebSocket } from './useWebSocket';

vi.stubGlobal('WebSocket', MockWebSocket);

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.resetMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects on mount when url provided', () => {
    renderHook(() => useWebSocket('wss://example.com'));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.lastInstance!.url).toBe('wss://example.com');
  });

  it('does not connect when url is null', () => {
    renderHook(() => useWebSocket(null));

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('disconnects on unmount', () => {
    const { unmount } = renderHook(() => useWebSocket('wss://example.com'));

    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();
    unmount();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('does NOT reconnect after unmount', () => {
    const { unmount } = renderHook(() =>
      useWebSocket('wss://example.com', { reconnect: true })
    );

    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();
    const instanceCountBeforeUnmount = MockWebSocket.instances.length;

    unmount();

    // ws.close() fires onclose synchronously. mountedRef should prevent reconnect.
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    // No new WebSocket instances should have been created
    expect(MockWebSocket.instances).toHaveLength(instanceCountBeforeUnmount);
  });

  it('auto-reconnects on close with exponential backoff', () => {
    renderHook(() =>
      useWebSocket('wss://example.com', {
        reconnect: true,
        reconnectInterval: 1000,
      })
    );

    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();

    // First close: reconnect after 1000ms (1000 * 2^0)
    ws.simulateClose();
    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second close without opening: backoff continues at 2000ms (1000 * 2^1)
    const ws2 = MockWebSocket.lastInstance!;
    ws2.simulateClose();

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('stops reconnecting after maxReconnectAttempts', () => {
    renderHook(() =>
      useWebSocket('wss://example.com', {
        reconnect: true,
        reconnectInterval: 1000,
        maxReconnectAttempts: 2,
      })
    );

    const ws1 = MockWebSocket.lastInstance!;
    ws1.simulateOpen();
    ws1.simulateClose();

    // Attempt 1
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    const ws2 = MockWebSocket.lastInstance!;
    ws2.simulateClose();

    // Attempt 2
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(MockWebSocket.instances).toHaveLength(3);

    const ws3 = MockWebSocket.lastInstance!;
    ws3.simulateClose();

    // No more attempts
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('subscribe receives parsed JSON messages', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket('wss://example.com'));

    act(() => {
      result.current.subscribe(handler);
    });

    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'test', value: 42 });

    expect(handler).toHaveBeenCalledWith({ type: 'test', value: 42 });
  });

  it('unsubscribe stops receiving messages', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket('wss://example.com'));

    let unsub: () => void;
    act(() => {
      unsub = result.current.subscribe(handler);
    });

    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();
    ws.simulateMessage({ first: true });
    expect(handler).toHaveBeenCalledTimes(1);

    act(() => {
      unsub();
    });

    ws.simulateMessage({ second: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('send transmits data when connected', () => {
    const { result } = renderHook(() => useWebSocket('wss://example.com'));

    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();

    act(() => {
      result.current.send({ action: 'ping' });
    });

    expect(ws.sentMessages).toEqual([JSON.stringify({ action: 'ping' })]);
  });

  it('send does nothing when not connected', () => {
    const { result } = renderHook(() => useWebSocket('wss://example.com'));

    const ws = MockWebSocket.lastInstance!;
    // Don't open the connection

    act(() => {
      result.current.send({ action: 'ping' });
    });

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('calls onOpen callback', () => {
    const onOpen = vi.fn();
    renderHook(() => useWebSocket('wss://example.com', { onOpen }));

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('calls onClose callback', () => {
    const onClose = vi.fn();
    renderHook(() =>
      useWebSocket('wss://example.com', { onClose, reconnect: false })
    );

    const ws = MockWebSocket.lastInstance!;
    ws.simulateOpen();
    act(() => {
      ws.simulateClose();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onError callback', () => {
    const onError = vi.fn();
    renderHook(() => useWebSocket('wss://example.com', { onError }));

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateError();
    });

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('resets reconnectAttempts on successful reconnection', () => {
    const { result } = renderHook(() =>
      useWebSocket('wss://example.com', {
        reconnect: true,
        reconnectInterval: 1000,
      })
    );

    const ws1 = MockWebSocket.lastInstance!;
    ws1.simulateOpen();
    ws1.simulateClose();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.reconnectAttempts).toBe(1);

    const ws2 = MockWebSocket.lastInstance!;
    act(() => {
      ws2.simulateOpen();
    });

    expect(result.current.reconnectAttempts).toBe(0);
    expect(result.current.isConnected).toBe(true);
  });

  it('reconnects when URL changes', () => {
    const { rerender } = renderHook(
      ({ url }) => useWebSocket(url),
      { initialProps: { url: 'wss://example.com/a' as string | null } }
    );

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('wss://example.com/a');

    rerender({ url: 'wss://example.com/b' });

    // Old one closed, new one created
    const urls = MockWebSocket.instances.map((i) => i.url);
    expect(urls).toContain('wss://example.com/b');
  });

  it('reports isConnected correctly', () => {
    const { result } = renderHook(() => useWebSocket('wss://example.com'));

    expect(result.current.isConnected).toBe(false);

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    expect(result.current.isConnected).toBe(true);

    act(() => {
      ws.simulateClose();
    });

    expect(result.current.isConnected).toBe(false);
  });
});
