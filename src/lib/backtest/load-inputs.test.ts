import { describe, it, expect } from 'vitest';
import { loadBacktestInputs } from './load-inputs';
import type { OHLCV } from '@/types/market';
import type { LeanSnapshot } from './snapshot-series';

const FIXED_NOW = 1_700_000_000_000;

function makeCandles(count: number, intervalMs = 3_600_000, start = 1_690_000_000_000): OHLCV[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: start + i * intervalMs,
    open: 100 + i * 0.1,
    high: 105 + i * 0.1,
    low: 95 + i * 0.1,
    close: 102 + i * 0.1,
    volume: 1000,
  }));
}

function makeSnapshot(timestamp: number): LeanSnapshot {
  return {
    timestamp,
    data: {
      fundingRate: { rate: 0.0001, markPrice: 100 },
      longShortRatio: { ratio: 1.5, longAccount: 0.6, shortAccount: 0.4 },
    },
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('loadBacktestInputs', () => {
  it('the legacy and deep URLs carry the right startTime and limit', async () => {
    const requestedUrls: string[] = [];
    const mockCandles = makeCandles(200);

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);

      if (url.includes('/api/candles')) {
        return jsonResponse({ candles: mockCandles });
      }
      if (url.includes('/api/historical-snapshots')) {
        return jsonResponse({ snapshots: [] });
      }
      return jsonResponse({});
    };

    // 1. Legacy range: 500 bars * 3600000ms = 1800000000ms
    const expectedLegacyStart = FIXED_NOW - 500 * 3_600_000;
    await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl,
    });

    const legacyCandleUrl = requestedUrls.find((u) => u.startsWith('/api/candles?symbol=BTCUSDT&interval=1h'));
    expect(legacyCandleUrl).toBe(
      `/api/candles?symbol=BTCUSDT&interval=1h&startTime=${expectedLegacyStart}&limit=500`
    );

    // 2. Deep range: 3 months = 3 * 30 * 24 * 60 * 60 * 1000ms = 7776000000ms
    requestedUrls.length = 0;
    const expectedDeepStart = FIXED_NOW - 3 * 30 * 24 * 60 * 60 * 1000;
    await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: '3m',
      now: FIXED_NOW,
      fetchImpl,
    });

    const deepCandleUrl = requestedUrls.find((u) => u.startsWith('/api/candles?symbol=BTCUSDT&interval=1h'));
    expect(deepCandleUrl).toBe(
      `/api/candles?symbol=BTCUSDT&interval=1h&startTime=${expectedDeepStart}&limit=50000`
    );
  });

  it('199 bars returns insufficient with bars: 199, and a non-ok candles response returns fetch_failed', async () => {
    // 199 bars
    const fetch199: typeof fetch = async () => {
      return jsonResponse({ candles: makeCandles(199) });
    };

    const insufficientResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetch199,
    });

    expect(insufficientResult).toEqual({
      ok: false,
      reason: 'insufficient',
      bars: 199,
      message: 'Insufficient candle data (199 bars). Try downloading history first.',
    });

    // 0 bars
    const fetch0: typeof fetch = async () => {
      return jsonResponse({ candles: [] });
    };

    const zeroResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetch0,
    });

    expect(zeroResult).toEqual({
      ok: false,
      reason: 'insufficient',
      bars: 0,
      message: 'Insufficient candle data (0 bars). Try downloading history first.',
    });

    // Non-ok response (500)
    const fetch500: typeof fetch = async () => {
      return new Response('Server error', { status: 500 });
    };

    const failedResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetch500,
    });

    expect(failedResult).toEqual({
      ok: false,
      reason: 'fetch_failed',
      bars: 0,
      message: 'Failed to fetch candle data.',
    });

    // Network error (rejection)
    const fetchNetworkError: typeof fetch = async () => {
      throw new Error('Connection refused');
    };

    const networkErrorResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetchNetworkError,
    });

    expect(networkErrorResult).toEqual({
      ok: false,
      reason: 'fetch_failed',
      bars: 0,
      message: 'Failed to fetch candle data.',
    });
  });

  it('snapshots build when available, and are undefined when the snapshot fetch fails, without failing the load', async () => {
    const candles = makeCandles(200);
    const snapshots = [makeSnapshot(candles[0].timestamp - 3_600_000)];

    // Success case
    const fetchSuccess: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/candles')) {
        return jsonResponse({ candles });
      }
      if (url.includes('/api/historical-snapshots')) {
        return jsonResponse({ snapshots });
      }
      return jsonResponse({});
    };

    const successResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetchSuccess,
    });

    expect(successResult.ok).toBe(true);
    if (successResult.ok) {
      expect(successResult.klines).toHaveLength(200);
      expect(successResult.snapshots).toBeDefined();
      expect(successResult.snapshots).toHaveLength(200);
    }

    // Snapshot fetch fails (500)
    const fetchSnapFails: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/candles')) {
        return jsonResponse({ candles });
      }
      if (url.includes('/api/historical-snapshots')) {
        return new Response('Snapshot service unavailable', { status: 500 });
      }
      return jsonResponse({});
    };

    const failureResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetchSnapFails,
    });

    expect(failureResult.ok).toBe(true);
    if (failureResult.ok) {
      expect(failureResult.klines).toHaveLength(200);
      expect(failureResult.snapshots).toBeUndefined();
    }
  });

  it('a 4h run makes the extra 1h snapshot read and a 1h run does not', async () => {
    const candles = makeCandles(200, 4 * 3_600_000);
    const requestedUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);
      if (url.includes('/api/candles')) {
        return jsonResponse({ candles });
      }
      if (url.includes('/api/historical-snapshots')) {
        return jsonResponse({ snapshots: [] });
      }
      return jsonResponse({});
    };

    // 4h run
    await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '4h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl,
    });

    const snapshotCalls4h = requestedUrls.filter((u) => u.startsWith('/api/historical-snapshots'));
    expect(snapshotCalls4h).toHaveLength(2);
    expect(snapshotCalls4h.some((u) => u.includes('interval=4h'))).toBe(true);
    expect(snapshotCalls4h.some((u) => u.includes('interval=1h'))).toBe(true);

    // 1h run
    requestedUrls.length = 0;
    await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl,
    });

    const snapshotCalls1h = requestedUrls.filter((u) => u.startsWith('/api/historical-snapshots'));
    expect(snapshotCalls1h).toHaveLength(1);
    expect(snapshotCalls1h[0]).toContain('interval=1h');
  });

  it('higher-timeframe input is present when available, and a failure adds the notice', async () => {
    const ltfCandles = makeCandles(200, 3_600_000);
    const htfCandles = makeCandles(250, 4 * 3_600_000);

    // Available case
    const fetchAvailable: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/candles')) {
        if (url.includes('interval=4h')) {
          return jsonResponse({ candles: htfCandles });
        }
        return jsonResponse({ candles: ltfCandles });
      }
      if (url.includes('/api/historical-snapshots')) {
        return jsonResponse({ snapshots: [] });
      }
      return jsonResponse({});
    };

    const availableResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetchAvailable,
    });

    expect(availableResult.ok).toBe(true);
    if (availableResult.ok) {
      expect(availableResult.htfInput).toEqual({
        candles: htfCandles,
        interval: '4h',
      });
      expect(availableResult.notices).toEqual([]);
    }

    // HTF fetch failure case (500)
    const fetchUnavailable: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/candles')) {
        if (url.includes('interval=4h')) {
          return new Response('HTF unavailable', { status: 500 });
        }
        return jsonResponse({ candles: ltfCandles });
      }
      if (url.includes('/api/historical-snapshots')) {
        return jsonResponse({ snapshots: [] });
      }
      return jsonResponse({});
    };

    const unavailableResult = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl: fetchUnavailable,
    });

    expect(unavailableResult.ok).toBe(true);
    if (unavailableResult.ok) {
      expect(unavailableResult.htfInput).toBeUndefined();
      expect(unavailableResult.notices).toEqual([
        'Higher-timeframe data unavailable; running without MTF confluence.',
      ]);
    }
  });

  it('an interval with no confirmation interval makes no higher-timeframe read', async () => {
    const candles1d = makeCandles(200, 24 * 3_600_000);
    const requestedCandleUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/candles')) {
        requestedCandleUrls.push(url);
        return jsonResponse({ candles: candles1d });
      }
      if (url.includes('/api/historical-snapshots')) {
        return jsonResponse({ snapshots: [] });
      }
      return jsonResponse({});
    };

    const result = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '1d',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.htfInput).toBeUndefined();
      expect(result.notices).toEqual([]);
    }

    // Only the primary 1d candle fetch was made; no HTF candle fetch
    expect(requestedCandleUrls).toHaveLength(1);
    expect(requestedCandleUrls[0]).toContain('interval=1d');
  });

  it('handles 4h run when 1h snapshot fetch fails by falling back to empty 1h rows', async () => {
    const candles = makeCandles(200, 4 * 3_600_000);
    const snapshots4h = [makeSnapshot(candles[0].timestamp - 4 * 3_600_000)];

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/candles')) {
        return jsonResponse({ candles });
      }
      if (url.includes('/api/historical-snapshots')) {
        if (url.includes('interval=1h')) {
          return new Response('1h snapshots error', { status: 500 });
        }
        return jsonResponse({ snapshots: snapshots4h });
      }
      return jsonResponse({});
    };

    const result = await loadBacktestInputs({
      symbol: 'BTCUSDT',
      interval: '4h',
      dataRange: 'legacy',
      now: FIXED_NOW,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshots).toBeDefined();
      expect(result.snapshots).toHaveLength(200);
    }
  });
});
