'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SegmentedControl } from '@/components/kit';
import { StateNotice } from '@/components/kit';
import { useChartTheme } from '@/lib/chart-theme';
import { useMarketStream } from '@/hooks/useMarketStream';
import { klineStream } from '@/lib/market-stream/streams';
import type { CombinedFrame } from '@/lib/market-stream/client';

export interface CandleData {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

const COIN_OPTIONS = [
  { value: 'BTC', label: 'BTC' },
  { value: 'ETH', label: 'ETH' },
];

function formatPrice(num: number): string {
  if (isNaN(num)) return 'n/a';
  if (num >= 1000) {
    return `$${num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } else if (num >= 1) {
    return `$${num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })}`;
  } else {
    return `$${num.toLocaleString('en-US', {
      minimumFractionDigits: 4,
      maximumFractionDigits: 6,
    })}`;
  }
}

/** Round prices inside [min, max] on a 1, 2 or 5 step chosen for about `count` lines. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0) || count < 1) return [];
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  // The candidate step whose line count lands closest to the target.
  const step = [1, 2, 5, 10]
    .map((m) => m * magnitude)
    .reduce((best, s) => (Math.abs(span / s - count) < Math.abs(span / best - count) ? s : best));
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

function formatHour(timestamp: number): string {
  const d = new Date(timestamp);
  const hours = String(d.getHours()).padStart(2, '0');
  return `${hours}:00`;
}

export function LiveCandles() {
  const [coin, setCoin] = useState<'BTC' | 'ETH'>('BTC');
  const symbol = coin === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
  const theme = useChartTheme();

  const containerRef = useRef<HTMLDivElement>(null);
  const hasAnimatedRef = useRef(false);

  const { data, isLoading, isError, refetch } = useQuery<CandleData[]>({
    queryKey: ['public-candles', symbol],
    queryFn: async () => {
      const res = await fetch(
        `/api/public/candles?symbol=${symbol}&interval=1h&limit=48`
      );
      if (!res.ok) {
        throw new Error('Failed to fetch candles');
      }
      return res.json();
    },
    staleTime: 60_000,
  });

  const [streamCandles, setStreamCandles] = useState<CandleData[] | null>(null);
  const [prevData, setPrevData] = useState(data);

  if (data !== prevData) {
    setPrevData(data);
    setStreamCandles(null);
  }

  const candles = streamCandles ?? data ?? [];

  const handleFrame = useCallback(
    (frame: CombinedFrame) => {
      const payload = frame.data as
        | {
            k?: {
              t: number;
              o: string | number;
              h: string | number;
              l: string | number;
              c: string | number;
              v?: string | number;
            };
          }
        | undefined;
      const k = payload?.k;
      if (!k || typeof k.t !== 'number') return;

      const candle: CandleData = {
        t: k.t,
        o: Number(k.o),
        h: Number(k.h),
        l: Number(k.l),
        c: Number(k.c),
        v: k.v !== undefined ? Number(k.v) : 0,
      };

      setStreamCandles((prev) => {
        const current = prev ?? data ?? [];
        if (current.length === 0) return prev;
        const last = current[current.length - 1];
        if (candle.t === last.t) {
          const next = [...current];
          next[next.length - 1] = candle;
          return next;
        }
        if (candle.t > last.t) {
          return [...current.slice(1), candle];
        }
        return prev;
      });
    },
    [data]
  );

  const streamNames = useMemo(() => [klineStream(symbol, '1h')], [symbol]);
  useMarketStream(streamNames, handleFrame);

  // Entrance motion on scroll into view
  useEffect(() => {
    const isReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    if (isReduced || hasAnimatedRef.current || !containerRef.current) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !hasAnimatedRef.current) {
          hasAnimatedRef.current = true;
          const groups =
            containerRef.current?.querySelectorAll<SVGGElement>(
              '[data-testid="candle-group"]'
            );
          groups?.forEach((g, idx) => {
            if (typeof g.animate === 'function') {
              g.animate(
                [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
                {
                  duration: 700,
                  delay: idx * 8,
                  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
                  fill: 'both',
                }
              );
            }
          });
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [candles.length]);

  if (isLoading && candles.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <SegmentedControl
            legend="Coin"
            options={COIN_OPTIONS}
            value={coin}
            onChange={(val) => setCoin(val as 'BTC' | 'ETH')}
          />
        </div>
        <div
          data-testid="live-candles-loading"
          className="w-full aspect-[8/3] rounded-panel bg-card/60 animate-pulse border border-line"
        />
      </div>
    );
  }

  if (isError && candles.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <SegmentedControl
            legend="Coin"
            options={COIN_OPTIONS}
            value={coin}
            onChange={(val) => setCoin(val as 'BTC' | 'ETH')}
          />
        </div>
        <StateNotice
          kind="error"
          title="Market data did not load."
          action={
            <button
              type="button"
              onClick={() => refetch()}
              className="min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer hover:border-foreground transition-colors"
            >
              Try again
            </button>
          }
        />
      </div>
    );
  }

  // Coordinate math
  const TOTAL_WIDTH = 960;
  const TOTAL_HEIGHT = 360;
  const PAD_TOP = 20;
  const PAD_BOTTOM = 36;
  const PAD_LEFT = 20;
  const PAD_RIGHT = 80;

  const plotWidth = TOTAL_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = TOTAL_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const xMin = PAD_LEFT;
  const xMax = PAD_LEFT + plotWidth;
  const yMin = PAD_TOP;
  const yMax = PAD_TOP + plotHeight;

  const minPrice =
    candles.length > 0 ? Math.min(...candles.map((c) => c.l)) : 0;
  const maxPrice =
    candles.length > 0 ? Math.max(...candles.map((c) => c.h)) : 1;
  const priceRange = maxPrice - minPrice || 1;
  const yDomainMin = minPrice - priceRange * 0.05;
  const yDomainMax = maxPrice + priceRange * 0.05;
  const domainRange = yDomainMax - yDomainMin;

  const getY = (price: number) =>
    yMax - ((price - yDomainMin) / domainRange) * plotHeight;

  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle?.c ?? 0;
  const lastY = getY(lastClose);

  // Grid lines at round prices (a 1, 2 or 5 step giving about four lines), so
  // every label names a price the axis really passes through. A line whose
  // label would sit under the last-price label is left out.
  const gridLines = niceTicks(yDomainMin, yDomainMax, 4)
    .map((price) => ({ price, y: getY(price) }))
    .filter((gl) => Math.abs(gl.y - lastY) > 16);

  const slotWidth = candles.length > 0 ? plotWidth / candles.length : 0;
  const bodyWidth = Math.max(3, slotWidth * 0.65);

  const ariaLabel = `${coin} hourly candles, last 48 hours, last price ${formatPrice(lastClose)}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SegmentedControl
          legend="Coin"
          options={COIN_OPTIONS}
          value={coin}
          onChange={(val) => setCoin(val as 'BTC' | 'ETH')}
        />
      </div>

      <div
        ref={containerRef}
        className="w-full rounded-panel border border-line bg-card/60 p-3 sm:p-4"
      >
        <svg
          viewBox={`0 0 ${TOTAL_WIDTH} ${TOTAL_HEIGHT}`}
          width="100%"
          role="img"
          aria-label={ariaLabel}
          className="overflow-visible select-none"
        >
          {/* Horizontal grid lines */}
          {gridLines.map((gl) => (
            <g key={gl.price}>
              <line
                x1={xMin}
                y1={gl.y}
                x2={xMax}
                y2={gl.y}
                stroke={theme.grid}
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <text
                x={TOTAL_WIDTH - 8}
                y={gl.y + 3.5}
                textAnchor="end"
                fill={theme.mutedText}
                className="tabular-nums text-[11px] font-sans"
              >
                {formatPrice(gl.price)}
              </text>
            </g>
          ))}

          {/* Time labels every 12 bars */}
          {candles.map((candle, idx) => {
            if (idx % 12 !== 0) return null;
            const cx = xMin + (idx + 0.5) * slotWidth;
            return (
              <text
                key={`time-${candle.t}`}
                x={cx}
                y={yMax + 20}
                textAnchor="middle"
                fill={theme.mutedText}
                className="tabular-nums text-[11px] font-sans"
              >
                {formatHour(candle.t)}
              </text>
            );
          })}

          {/* Candle bars */}
          {candles.map((candle, idx) => {
            const cx = xMin + (idx + 0.5) * slotWidth;
            const isUp = candle.c >= candle.o;
            const barColor = isUp ? theme.up : theme.down;
            const wickY1 = getY(candle.h);
            const wickY2 = getY(candle.l);
            const openY = getY(candle.o);
            const closeY = getY(candle.c);
            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
            const isLast = idx === candles.length - 1;

            return (
              <g
                key={candle.t}
                data-testid="candle-group"
                className="candle-group"
                opacity={isLast ? 0.6 : 1}
                style={{
                  transformOrigin: `${cx}px ${openY}px`,
                }}
              >
                <line
                  x1={cx}
                  y1={wickY1}
                  x2={cx}
                  y2={wickY2}
                  stroke={barColor}
                  strokeWidth="1.5"
                />
                <rect
                  x={cx - bodyWidth / 2}
                  y={bodyTop}
                  width={bodyWidth}
                  height={bodyHeight}
                  fill={barColor}
                  rx="1"
                />
              </g>
            );
          })}

          {/* Last close dashed line & price label box */}
          {lastCandle && (
            <g>
              <line
                x1={xMin}
                y1={lastY}
                x2={xMax}
                y2={lastY}
                stroke={lastCandle.c >= lastCandle.o ? theme.up : theme.down}
                strokeDasharray="4 4"
                strokeWidth="1"
              />
              <rect
                x={xMax + 4}
                y={Math.max(yMin, Math.min(yMax - 18, lastY - 9))}
                width={72}
                height={18}
                rx="3"
                fill={theme.line || '#24272D'}
              />
              <text
                data-testid="last-close-label"
                x={xMax + 40}
                y={Math.max(yMin, Math.min(yMax - 18, lastY - 9)) + 12.5}
                textAnchor="middle"
                fill={lastCandle.c >= lastCandle.o ? theme.up : theme.down}
                className="tabular-nums text-[10px] font-semibold"
              >
                {formatPrice(lastClose)}
              </text>
            </g>
          )}
        </svg>

        <p className="mt-2 text-xs text-muted-foreground">
          Hourly candles from Binance public market data. The last one is still forming.
        </p>
      </div>
    </div>
  );
}
