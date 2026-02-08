'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface WebSocketOptions {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface WebSocketState {
  isConnected: boolean;
  reconnectAttempts: number;
}

export function useWebSocket<T = unknown>(
  url: string | null,
  options: WebSocketOptions = {}
) {
  const {
    reconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5,
  } = options;

  const [state, setState] = useState<WebSocketState>({
    isConnected: false,
    reconnectAttempts: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageHandlersRef = useRef<Set<(data: T) => void>>(new Set());
  const reconnectAttemptsRef = useRef(0);
  const mountedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});

  // Store callbacks in a ref so event handlers always see the latest without
  // needing them in dependency arrays. Must be in an effect per React Compiler rules.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const connect = useCallback(() => {
    if (!url) return;

    if (wsRef.current) {
      wsRef.current.close();
    }

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setState({ isConnected: true, reconnectAttempts: 0 });
        optionsRef.current.onOpen?.();
      };

      ws.onclose = () => {
        setState((prev) => ({ ...prev, isConnected: false }));
        optionsRef.current.onClose?.();

        // Only reconnect if the effect is still active (not unmounted)
        if (
          mountedRef.current &&
          reconnect &&
          reconnectAttemptsRef.current < maxReconnectAttempts
        ) {
          const delay =
            reconnectInterval * Math.pow(2, reconnectAttemptsRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current += 1;
            setState((prev) => ({
              ...prev,
              reconnectAttempts: reconnectAttemptsRef.current,
            }));
            connectRef.current();
          }, delay);
        }
      };

      ws.onerror = (error) => {
        optionsRef.current.onError?.(error);
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as T;
          messageHandlersRef.current.forEach((handler) => handler(data));
        } catch {
          // ignore unparseable messages
        }
      };

      wsRef.current = ws;
    } catch {
      // connection failed, will be retried by onclose handler
    }
  }, [url, reconnect, reconnectInterval, maxReconnectAttempts]);

  useEffect(() => {
    connectRef.current = connect;
    mountedRef.current = true;
    connect();

    return () => {
      // Set mounted to false BEFORE closing so the synchronous onclose
      // handler sees the flag and skips reconnection.
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  const subscribe = useCallback((handler: (data: T) => void) => {
    messageHandlersRef.current.add(handler);
    return () => {
      messageHandlersRef.current.delete(handler);
    };
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
    }
  }, []);

  return {
    isConnected: state.isConnected,
    reconnectAttempts: state.reconnectAttempts,
    subscribe,
    send,
    connect,
    disconnect,
  };
}
