'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMarketStream } from '@/hooks/useMarketStream';
import { klineStream } from '@/lib/market-stream/streams';
import type { CombinedFrame } from '@/lib/market-stream/client';

export interface BarArrival {
  closeTime: number;
  receivedAt: number;
  lagMs: number;
}

export function barArrivalFrom(data: unknown, now: number): BarArrival | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const k = (data as { k?: unknown }).k;
  if (!k || typeof k !== 'object') {
    return null;
  }
  const kline = k as { x?: unknown; T?: unknown };
  if (kline.x !== true) {
    return null;
  }
  if (typeof kline.T !== 'number' || !Number.isFinite(kline.T)) {
    return null;
  }

  const closeTime = kline.T;
  const receivedAt = now;
  const lagMs = Math.max(0, receivedAt - (closeTime + 1));

  return { closeTime, receivedAt, lagMs };
}

export function useBarArrivalLag(symbol = 'BTCUSDT'): BarArrival | null {
  const [arrival, setArrival] = useState<BarArrival | null>(null);
  const stream = useMemo(() => klineStream(symbol, '1m'), [symbol]);
  const streams = useMemo(() => [stream], [stream]);

  const onFrame = useCallback(
    (frame: CombinedFrame) => {
      if (frame.stream !== stream) {
        return;
      }
      const parsed = barArrivalFrom(frame.data, Date.now());
      if (parsed) {
        setArrival(parsed);
      }
    },
    [stream]
  );

  useMarketStream(streams, onFrame);

  return arrival;
}
