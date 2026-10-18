'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMarketStream, useMarketStreamStatus } from './useMarketStream';
import { tickerStream } from '@/lib/market-stream/streams';
import type { CombinedFrame } from '@/lib/market-stream/client';
import type { Ticker24h } from '@/types/market';

interface BinanceTickerMsg {
  e: string;
  s: string;
  p: string;
  P: string;
  c: string;
  o: string;
  h: string;
  l: string;
  v: string;
  q: string;
  n: number;
}

export function useBinanceTicker(symbols: string[]) {
  const [tickers, setTickers] = useState<Record<string, Ticker24h>>({});
  const pendingUpdatesRef = useRef<Record<string, Ticker24h>>({});
  const rafIdRef = useRef<number | null>(null);

  const symbolsKey = symbols.join(',');
  const streamNames = useMemo(() => {
    if (!symbolsKey) {
      return [];
    }
    return symbolsKey.split(',').map(tickerStream);
  }, [symbolsKey]);

  const flushUpdates = useCallback(() => {
    const updates = pendingUpdatesRef.current;
    pendingUpdatesRef.current = {};
    rafIdRef.current = null;
    setTickers((prev) => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        if (typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(rafIdRef.current);
        }
        rafIdRef.current = null;
      }
    };
  }, []);

  const handleFrame = useCallback(
    (frame: CombinedFrame) => {
      const d = frame.data as BinanceTickerMsg | null | undefined;
      if (!d || typeof d !== 'object' || typeof d.s !== 'string') {
        return;
      }

      pendingUpdatesRef.current[d.s] = {
        symbol: d.s,
        lastPrice: d.c,
        priceChange: d.p,
        priceChangePercent: d.P,
        highPrice: d.h,
        lowPrice: d.l,
        volume: d.v,
        quoteVolume: d.q,
        openPrice: d.o,
        count: d.n,
      };

      if (rafIdRef.current === null) {
        if (typeof requestAnimationFrame !== 'undefined') {
          rafIdRef.current = requestAnimationFrame(flushUpdates);
        } else {
          flushUpdates();
        }
      }
    },
    [flushUpdates]
  );

  useMarketStream(streamNames, handleFrame);

  const { isConnected, status, lastMessageAt, retry } = useMarketStreamStatus();

  return { tickers, isConnected, status, lastMessageAt, retry };
}
