'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import type { Ticker24h, OHLCV } from '@/types/market';

const DEFAULT_WS_BASE = 'wss://stream.binance.com:9443';

function getBinanceWsBase(): string {
  return process.env.NEXT_PUBLIC_BINANCE_WS_URL || DEFAULT_WS_BASE;
}

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

interface BinanceKlineMsg {
  e: string;
  s: string;
  k: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x: boolean;
  };
}

function buildTickerStreamUrl(symbols: string[]): string | null {
  if (symbols.length === 0) return null;
  const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
  return `${getBinanceWsBase()}/stream?streams=${streams}`;
}

function buildKlineStreamUrl(
  symbol: string | null,
  interval: string
): string | null {
  if (!symbol) return null;
  return `${getBinanceWsBase()}/ws/${symbol.toLowerCase()}@kline_${interval}`;
}

export function useBinanceTicker(symbols: string[]) {
  const [tickers, setTickers] = useState<Record<string, Ticker24h>>({});
  const pendingUpdatesRef = useRef<Record<string, Ticker24h>>({});
  const rafIdRef = useRef<number | null>(null);

  // Stabilize URL: only recompute when the actual symbol list changes,
  // not when the caller passes a new array reference with the same values.
  const symbolsKey = symbols.join(',');
  const url = useMemo(
    () => buildTickerStreamUrl(symbols),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symbolsKey]
  );

  const { isConnected, subscribe } = useWebSocket<{
    stream: string;
    data: BinanceTickerMsg;
  }>(url, { reconnect: true, maxReconnectAttempts: 10 });

  const flushUpdates = useCallback(() => {
    const updates = pendingUpdatesRef.current;
    pendingUpdatesRef.current = {};
    rafIdRef.current = null;
    setTickers((prev) => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    const unsub = subscribe((msg) => {
      const d = msg.data;
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
        rafIdRef.current = requestAnimationFrame(flushUpdates);
      }
    });
    return () => {
      unsub();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [subscribe, flushUpdates]);

  return { tickers, isConnected };
}

export function useBinanceKline(symbol: string | null, interval: string) {
  const [latestCandle, setLatestCandle] = useState<OHLCV | null>(null);
  const [isClosed, setIsClosed] = useState(false);

  const url = useMemo(
    () => buildKlineStreamUrl(symbol, interval),
    [symbol, interval]
  );

  const { isConnected, subscribe } = useWebSocket<BinanceKlineMsg>(url, {
    reconnect: true,
    maxReconnectAttempts: 10,
  });

  useEffect(() => {
    const unsub = subscribe((msg) => {
      const k = msg.k;
      setLatestCandle({
        timestamp: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
      });
      setIsClosed(k.x);
    });
    return unsub;
  }, [subscribe]);

  return { latestCandle, isClosed, isConnected };
}
