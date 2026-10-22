'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  getMarketStreamClient,
  getPerpMarketStreamClient,
  type CombinedFrame,
  type StreamMarket,
  type StreamSnapshot,
  type StreamStatus,
} from '@/lib/market-stream/client';

export interface MarketStreamStatus {
  status: StreamStatus;
  lastMessageAt: number | null;
  /** True while a connection is open and delivering or recently delivered (live or stale). */
  isConnected: boolean;
  retry: () => void;
}

const SERVER_SNAPSHOT: StreamSnapshot = {
  status: 'connecting',
  lastMessageAt: null,
};

function getServerStatusSnapshot(): StreamSnapshot {
  return SERVER_SNAPSHOT;
}

const SUBSCRIBERS: Record<StreamMarket, (listener: () => void) => () => void> = {
  spot: (listener) => getMarketStreamClient().onChange(listener),
  perp: (listener) => getPerpMarketStreamClient().onChange(listener),
};

const SNAPSHOT_GETTERS: Record<StreamMarket, () => StreamSnapshot> = {
  spot: () => getMarketStreamClient().getSnapshot(),
  perp: () => getPerpMarketStreamClient().getSnapshot(),
};

const RETRY_ACTIONS: Record<StreamMarket, () => void> = {
  spot: () => getMarketStreamClient().retry(),
  perp: () => getPerpMarketStreamClient().retry(),
};

/** The shared stream's status for this page (useSyncExternalStore over the client). */
export function useMarketStreamStatus(market: StreamMarket = 'spot'): MarketStreamStatus {
  const snapshot = useSyncExternalStore(
    SUBSCRIBERS[market],
    SNAPSHOT_GETTERS[market],
    getServerStatusSnapshot
  );

  return {
    status: snapshot.status,
    lastMessageAt: snapshot.lastMessageAt,
    isConnected: snapshot.status === 'live' || snapshot.status === 'stale',
    retry: RETRY_ACTIONS[market],
  };
}

/**
 * Subscribes to the given stream names while mounted and calls onFrame for each frame.
 * Re-subscribes only when the SET of names changes (sorted and joined key), not when the
 * caller passes a new array with the same names. The latest onFrame is always used.
 * An empty list subscribes to nothing.
 */
export function useMarketStream(
  streams: readonly string[],
  onFrame: (frame: CombinedFrame) => void,
  market: StreamMarket = 'spot'
): void {
  const onFrameRef = useRef(onFrame);

  useEffect(() => {
    onFrameRef.current = onFrame;
  });

  const sortedKey = useMemo(() => {
    if (streams.length === 0) {
      return '';
    }
    return Array.from(new Set(streams)).sort().join('/');
  }, [streams]);

  useEffect(() => {
    if (!sortedKey) {
      return;
    }
    const names = sortedKey.split('/');
    const client = market === 'perp' ? getPerpMarketStreamClient() : getMarketStreamClient();
    return client.subscribe(names, (frame) => {
      onFrameRef.current(frame);
    });
  }, [sortedKey, market]);
}
