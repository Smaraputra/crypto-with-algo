import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { TRACK_BARS_CHUNK, type TrackBarsResponse } from '@/lib/signals/track-record/types';

import { isTrackRecordEligible, useTrackRecord, useTrackRecordBars } from './useTrackRecord';

const HOUR = 3_600_000;
const SPAN = TRACK_BARS_CHUNK * HOUR;

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function barsFor(url: URL): TrackBarsResponse {
  const from = Number(url.searchParams.get('from'));
  return {
    available: true,
    configVersion: 8,
    boundary: 5 * SPAN,
    horizonBars: 24,
    costPercent: 0.16,
    bars: [
      { t: from, score: 31, tier: 'buy', fwd: 0.5, source: 'rescore' },
      { t: from + HOUR, score: 3, tier: 'neutral', fwd: 0.1, source: 'rescore' },
    ],
  };
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/bars')) return new Response(JSON.stringify(barsFor(url)));
    return new Response(JSON.stringify({ available: false, reason: 'no-run' }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isTrackRecordEligible', () => {
  it('needs a signal symbol and a re-scored cell', () => {
    expect(isTrackRecordEligible('BTCUSDT', '1h', 'day_trading')).toBe(true);
    expect(isTrackRecordEligible('BTCUSDT', '1d', 'position_trading')).toBe(true);
    expect(isTrackRecordEligible('BTCUSDT', '1m', 'scalping')).toBe(false);
    expect(isTrackRecordEligible('PEPEUSDT', '1h', 'day_trading')).toBe(false);
    expect(isTrackRecordEligible('BTCUSDT', '1h', null)).toBe(false);
  });
});

describe('useTrackRecord', () => {
  it('fetches the summary for an eligible cell', async () => {
    const { result } = renderHook(() => useTrackRecord('BTCUSDT', '1h', 'day_trading'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/signals/track-record?symbol=BTCUSDT&interval=1h&style=day_trading');
    expect(result.current.data).toEqual({ available: false, reason: 'no-run' });
  });

  it('does not fetch for a cell the re-score does not cover', () => {
    renderHook(() => useTrackRecord('BTCUSDT', '1m', 'scalping'), { wrapper: createWrapper() });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useTrackRecordBars', () => {
  it('waits for the chart to report a range', () => {
    const { result } = renderHook(() => useTrackRecordBars('BTCUSDT', '1h', 'day_trading', null), { wrapper: createWrapper() });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.bars.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('asks for each aligned chunk of the range and merges the bars and calls', async () => {
    const range = { from: 3 * SPAN + 10 * HOUR, to: 4 * SPAN + 20 * HOUR };
    const { result } = renderHook(() => useTrackRecordBars('BTCUSDT', '1h', 'day_trading', range), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const urls = fetchMock.mock.calls.map((c) => new URL(String(c[0]), 'http://localhost'));
    expect(urls.map((u) => [u.searchParams.get('from'), u.searchParams.get('to')])).toEqual([
      [String(3 * SPAN), String(4 * SPAN - 1)],
      [String(4 * SPAN), String(5 * SPAN - 1)],
    ]);
    expect(result.current.bars.size).toBe(4);
    expect([...result.current.calls.keys()]).toEqual([3 * SPAN, 4 * SPAN]);
    expect(result.current.calls.get(3 * SPAN)?.outcome).toBe('won');
    expect(result.current).toMatchObject({ boundary: 5 * SPAN, configVersion: 8, horizonBars: 24, costPercent: 0.16, error: false });
  });

  it('reports an error when a chunk fails', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"boom"}', { status: 500 }));
    const range = { from: 3 * SPAN, to: 3 * SPAN + HOUR };
    const { result } = renderHook(() => useTrackRecordBars('BTCUSDT', '1h', 'day_trading', range), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('returns nothing for an ineligible cell even with a range', () => {
    const { result } = renderHook(
      () => useTrackRecordBars('BTCUSDT', '1m', 'scalping', { from: 0, to: SPAN }),
      { wrapper: createWrapper() }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.boundary).toBeNull();
  });
});
