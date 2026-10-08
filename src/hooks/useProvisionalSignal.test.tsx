import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCandles, seedFor } from '@/__fixtures__/scoring-fixture';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import type { FormingBar, ProvisionalContext } from '@/lib/signals/provisional/types';
import { useFormingBarStore } from '@/stores/formingBarStore';
import { useProvisionalSignal } from './useProvisionalSignal';

const mocks = vi.hoisted(() => ({ score: vi.fn() }));

vi.mock('@/lib/signals/provisional/score-provisional', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/signals/provisional/score-provisional')>();
  mocks.score.mockImplementation(actual.scoreProvisional);
  return { scoreProvisional: (...args: Parameters<typeof actual.scoreProvisional>) => mocks.score(...args) };
});

const HOUR = 3_600_000;
const FORMING = Date.UTC(2026, 9, 9, 5, 0, 0, 0);
const NEXT = FORMING + HOUR;
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const STYLE = 'day_trading';
const ALLOWED = [
  '/api/signals/provisional-context',
  '/api/signals/global',
  '/api/signals/latest',
];

function readyContext(formingOpenTime = FORMING): ProvisionalContext {
  return {
    ready: true,
    configVersion: 8,
    symbol: SYMBOL,
    interval: INTERVAL,
    style: STYLE,
    formingOpenTime,
    closedCandles: buildCandles({
      symbol: SYMBOL,
      interval: INTERVAL,
      count: 499,
      endOpenTime: formingOpenTime - HOUR,
      seed: seedFor('hook', SYMBOL),
      startPrice: 60000,
    }),
    futures: null,
    sentiment: null,
    weights: DEFAULT_TEMPLATE_WEIGHTS.day_trading,
    htfContext: null,
    generatedAt: formingOpenTime + 60_000,
  };
}

function bar(close: number, openTime = FORMING): FormingBar {
  return {
    openTime,
    open: 60000,
    high: Math.max(60000, close) + 5,
    low: Math.min(60000, close) - 5,
    close,
    volume: 120,
    takerBuyVolume: 55,
  };
}

function tick(b: FormingBar, closed = false) {
  act(() => {
    useFormingBarStore.getState().push({
      symbol: SYMBOL,
      interval: INTERVAL,
      bar: b,
      closed,
      receivedAt: Date.now(),
    });
  });
}

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

interface Server {
  context: ProvisionalContext;
  latest: { candleTimestamp: number; score: number } | null;
  fetchSpy: ReturnType<typeof vi.spyOn>;
  count: (path: string) => number;
}

function startServer(context: ProvisionalContext): Server {
  const server = { context, latest: null } as Server;
  server.fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/signals/provisional-context') {
      return new Response(JSON.stringify(server.context));
    }
    if (url.pathname === '/api/signals/global') return new Response(JSON.stringify({ signals: [] }));
    if (url.pathname === '/api/signals/latest') {
      const signal = server.latest
        ? { ...server.latest, tier: 'neutral', confidence: 40.5, configVersion: 8 }
        : null;
      return new Response(JSON.stringify({ signal }));
    }
    return new Response('{}', { status: 404 });
  });
  server.count = (path) =>
    server.fetchSpy.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith(path)).length;
  return server;
}

function setup(symbol = SYMBOL, interval = INTERVAL, style: 'day_trading' | null = STYLE) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
  return renderHook(() => useProvisionalSignal(symbol, interval, style), { wrapper });
}

beforeEach(() => {
  vi.useFakeTimers({ now: FORMING + 60_000 });
  mocks.score.mockClear();
  useFormingBarStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useProvisionalSignal compute floor', () => {
  it('computes on the first tick, throttles the next, and skips an identical bar', async () => {
    startServer(readyContext());
    const { result } = setup();
    await flush();
    expect(result.current.status).toBe('waiting');
    expect(result.current.configVersion).toBe(8);

    tick(bar(60010));
    expect(mocks.score).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('provisional');
    expect(result.current.provisional?.openTime).toBe(FORMING);
    expect(result.current.lastComputeMs).toBeTypeOf('number');

    await flush(500);
    tick(bar(60020));
    await flush(500);
    tick(bar(60030));
    expect(mocks.score).toHaveBeenCalledTimes(1);

    await flush(1_000);
    expect(mocks.score).toHaveBeenCalledTimes(2);
    expect(mocks.score.mock.calls[1][1]).toEqual(bar(60030));

    await flush(2_000);
    tick(bar(60030));
    expect(mocks.score).toHaveBeenCalledTimes(2);

    tick(bar(60040));
    expect(mocks.score).toHaveBeenCalledTimes(3);
  });

  it('drops a pending trailing bar when the displayed bar arrives again', async () => {
    startServer(readyContext());
    const { result } = setup();
    await flush();

    tick(bar(60010));
    const shown = result.current.provisional?.score;
    expect(mocks.score).toHaveBeenCalledTimes(1);

    await flush(500);
    tick(bar(60500));
    expect(mocks.score).toHaveBeenCalledTimes(1);
    await flush(500);
    tick(bar(60010));

    await flush(5_000);
    expect(mocks.score).toHaveBeenCalledTimes(1);
    expect(result.current.provisional?.score).toBe(shown);
  });

  it('ignores events for another symbol or interval', async () => {
    startServer(readyContext());
    setup();
    await flush();
    act(() => {
      useFormingBarStore.getState().push({
        symbol: 'ETHUSDT', interval: INTERVAL, bar: bar(60010), closed: false, receivedAt: 0,
      });
      useFormingBarStore.getState().push({
        symbol: SYMBOL, interval: '4h', bar: bar(60010), closed: false, receivedAt: 0,
      });
    });
    expect(mocks.score).not.toHaveBeenCalled();
  });
});

describe('useProvisionalSignal persistence and requests', () => {
  it('makes only GET requests to the three routes, never stores a score', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const server = startServer(readyContext());
    const { result } = setup();
    await flush();
    tick(bar(60010));
    await flush(2_000);
    tick(bar(60500));
    tick(bar(60500), true);
    await flush(60_000);

    const score = result.current.provisional?.score;
    expect(score).toBeTypeOf('number');
    expect(server.fetchSpy.mock.calls.length).toBeGreaterThan(2);
    for (const [input, init] of server.fetchSpy.mock.calls as [unknown, RequestInit | undefined][]) {
      const url = String(input);
      expect(ALLOWED).toContain(new URL(url, 'http://localhost').pathname);
      expect(init?.body).toBeUndefined();
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url).not.toContain(String(score));
    }
    expect(setItem).not.toHaveBeenCalled();
    const stored = JSON.stringify(useFormingBarStore.getState());
    for (const k of ['score', 'tier', 'confidence', 'components']) {
      expect(stored).not.toContain(`"${k}"`);
    }
  });
});

describe('useProvisionalSignal bar close', () => {
  it('awaits the record, ignores an older one, then shows the matching one', async () => {
    const server = startServer(readyContext());
    const { result } = setup();
    await flush();
    tick(bar(60010));
    tick(bar(60100), true);
    expect(result.current.status).toBe('awaiting-record');
    expect(result.current.provisional?.openTime).toBe(FORMING);
    expect(mocks.score).toHaveBeenCalledTimes(2);

    server.latest = { candleTimestamp: FORMING - HOUR, score: 1.25 };
    await flush(10_000);
    expect(server.count('/api/signals/latest')).toBe(1);
    expect(result.current.status).toBe('awaiting-record');
    expect(result.current.provisional).not.toBeNull();

    server.latest = { candleTimestamp: FORMING, score: 33.125 };
    await flush(10_000);
    expect(result.current.status).toBe('recorded');
    expect(result.current.provisional).toBeNull();
    expect(result.current.recorded.get(FORMING)).toEqual({
      score: 33.125, tier: 'neutral', confidence: 40.5, configVersion: 8,
    });
  });

  it('gives up after the cadence plus five minutes and clears the provisional value', async () => {
    const server = startServer(readyContext());
    const { result } = setup();
    await flush();
    tick(bar(60010), true);
    expect(result.current.status).toBe('awaiting-record');

    server.latest = { candleTimestamp: FORMING - HOUR, score: 1 };
    await flush(9 * 60_000);
    expect(result.current.status).toBe('awaiting-record');
    await flush(60_000 + 1_000);
    expect(result.current.status).toBe('no-record');
    expect(result.current.provisional).toBeNull();
    const polls = server.count('/api/signals/latest');
    await flush(60_000);
    expect(server.count('/api/signals/latest')).toBe(polls);
  });

  it('refetches the context when a later bar opens and computes once it arrives', async () => {
    const server = startServer(readyContext());
    setup();
    await flush();
    expect(server.count('/api/signals/provisional-context')).toBe(1);

    server.context = readyContext(NEXT);
    tick(bar(60010, NEXT));
    expect(mocks.score).not.toHaveBeenCalled();
    await flush();
    expect(server.count('/api/signals/provisional-context')).toBe(2);
    expect(mocks.score).toHaveBeenCalledTimes(1);
    expect(mocks.score.mock.calls[0][0].formingOpenTime).toBe(NEXT);
  });
});

describe('useProvisionalSignal availability', () => {
  it.each([
    ['an unknown symbol', 'PEPEUSDT', INTERVAL, STYLE],
    ['no style', SYMBOL, INTERVAL, null],
    ['an interval the style does not score', SYMBOL, '4h', STYLE],
  ] as const)('is unavailable with no fetch for %s', async (_label, symbol, interval, style) => {
    const server = startServer(readyContext());
    const { result } = setup(symbol, interval, style);
    await flush(60_000);
    expect(result.current.status).toBe('unavailable');
    expect(server.fetchSpy).not.toHaveBeenCalled();
  });

  it('waits with the reason and retries every 30 seconds when the context is not ready', async () => {
    const server = startServer({
      ready: false,
      reason: 'awaiting-candle-sync',
      configVersion: 8,
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      formingOpenTime: FORMING,
      generatedAt: FORMING,
    });
    const { result } = setup();
    expect(result.current.status).toBe('loading');
    await flush();
    expect(result.current.status).toBe('waiting');
    expect(result.current.reason).toBe('awaiting-candle-sync');
    expect(server.count('/api/signals/provisional-context')).toBe(1);

    await flush(30_000);
    expect(server.count('/api/signals/provisional-context')).toBe(2);
    await flush(30_000);
    expect(server.count('/api/signals/provisional-context')).toBe(3);
  });

  it('clears every timer and subscription on unmount', async () => {
    startServer(readyContext());
    const { unmount } = setup();
    await flush();
    tick(bar(60010));
    tick(bar(60020));
    tick(bar(60030), true);
    const server = vi.mocked(globalThis.fetch);
    unmount();
    const fetches = server.mock.calls.length;
    const calls = mocks.score.mock.calls.length;
    tick(bar(60040));
    await flush(15 * 60_000);
    expect(mocks.score.mock.calls.length).toBe(calls);
    expect(server.mock.calls.length).toBe(fetches);
  });
});

describe('useProvisionalSignal key changes', () => {
  it('tears down the old subscription and timers when the interval changes', async () => {
    const server = startServer(readyContext());
    let interval = INTERVAL;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    };
    const { result, rerender } = renderHook(() => useProvisionalSignal(SYMBOL, interval, STYLE), { wrapper });
    await flush();
    tick(bar(60010));
    tick(bar(60020));
    expect(mocks.score).toHaveBeenCalledTimes(1);

    interval = '4h';
    rerender();
    await flush();
    expect(result.current.status).toBe('unavailable');

    const calls = mocks.score.mock.calls.length;
    const fetches = server.fetchSpy.mock.calls.length;
    tick(bar(60030));
    await flush(15 * 60_000);
    expect(mocks.score.mock.calls.length).toBe(calls);
    expect(server.fetchSpy.mock.calls.length).toBe(fetches);
  });
});
