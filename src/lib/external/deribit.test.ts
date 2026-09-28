import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalCdf } from '@/lib/stats/normal';

import {
  DERIBIT_API_URL,
  DERIBIT_HISTORY_URL,
  DERIBIT_CURRENCIES,
  dvolUrl,
  optionTradesUrl,
  fetchDvol,
  fetchOptionTrades,
  parseInstrument,
  yearsToExpiry,
  blackScholesDelta,
  blackScholesGamma,
} from './deribit';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('constants', () => {
  it('exposes the two hosts and the supported currencies', () => {
    expect(DERIBIT_API_URL).toBe('https://www.deribit.com/api/v2');
    expect(DERIBIT_HISTORY_URL).toBe('https://history.deribit.com/api/v2');
    expect(DERIBIT_CURRENCIES).toEqual(['BTC', 'ETH']);
  });
});

describe('dvolUrl', () => {
  it('builds the volatility index url', () => {
    expect(dvolUrl('BTC', 1000, 2000, 3600)).toBe(
      'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=1000&end_timestamp=2000&resolution=3600'
    );
  });

  it('accepts the "1D" resolution', () => {
    expect(dvolUrl('ETH', 0, 1, '1D')).toContain('resolution=1D');
  });
});

describe('optionTradesUrl', () => {
  it('builds the trade history url with include_old', () => {
    expect(optionTradesUrl('BTC', 1000, 2000, 10000)).toBe(
      'https://history.deribit.com/api/v2/public/get_last_trades_by_currency_and_time?currency=BTC&kind=option&start_timestamp=1000&end_timestamp=2000&count=10000&include_old=true'
    );
  });
});

describe('parseInstrument', () => {
  it('parses a two-digit-day call', () => {
    expect(parseInstrument('BTC-28JAN22-56000-C')).toEqual({
      currency: 'BTC',
      expiryMs: Date.UTC(2022, 0, 28, 8, 0, 0),
      strike: 56000,
      isCall: true,
    });
  });

  it('parses a one-digit-day put', () => {
    expect(parseInstrument('BTC-8OCT21-50000-P')).toEqual({
      currency: 'BTC',
      expiryMs: Date.UTC(2021, 9, 8, 8, 0, 0),
      strike: 50000,
      isCall: false,
    });
  });

  it('reads a "d" decimal strike', () => {
    expect(parseInstrument('ETH-25MAR22-3000d5-C')).toEqual({
      currency: 'ETH',
      expiryMs: Date.UTC(2022, 2, 25, 8, 0, 0),
      strike: 3000.5,
      isCall: true,
    });
  });

  it('returns null for a perpetual', () => {
    expect(parseInstrument('BTC-PERPETUAL')).toBeNull();
  });

  it('returns null for a futures spread', () => {
    expect(parseInstrument('BTC-FS-28JAN22_25FEB22')).toBeNull();
  });

  it('returns null for a malformed month', () => {
    expect(parseInstrument('BTC-28XXX22-56000-C')).toBeNull();
  });
});

describe('yearsToExpiry', () => {
  it('reads an exact one-year gap as 1', () => {
    expect(yearsToExpiry(Date.UTC(2023, 0, 1), Date.UTC(2022, 0, 1))).toBeCloseTo(1, 10);
  });

  it('is negative once expiry has passed', () => {
    expect(yearsToExpiry(Date.UTC(2022, 0, 1), Date.UTC(2023, 0, 1))).toBeLessThan(0);
  });
});

describe('blackScholesDelta and blackScholesGamma', () => {
  it('at the money, delta equals Phi(sigma*sqrt(tau)/2) with r=0, and put = call - 1', () => {
    const spot = 100;
    const strike = 100;
    const tau = 0.5;
    const sigma = 0.6;

    const callDelta = blackScholesDelta(spot, strike, tau, sigma, true);
    const putDelta = blackScholesDelta(spot, strike, tau, sigma, false);
    const expected = normalCdf((sigma * Math.sqrt(tau)) / 2);

    expect(callDelta).toBeCloseTo(expected, 12);
    expect(putDelta).toBeCloseTo(expected - 1, 12);
  });

  it('call delta tends to 1 deep in the money and to 0 deep out of the money', () => {
    expect(blackScholesDelta(1000, 100, 0.5, 0.6, true)).toBeGreaterThan(0.99);
    expect(blackScholesDelta(50, 1000, 0.5, 0.6, true)).toBeLessThan(0.01);
  });

  it('gamma equals phi(d1)/(S*sigma*sqrt(tau)) and is the same for calls and puts', () => {
    const spot = 100;
    const strike = 90;
    const tau = 0.25;
    const sigma = 0.8;

    const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * tau) / (sigma * Math.sqrt(tau));
    const expected = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI) / (spot * sigma * Math.sqrt(tau));

    expect(blackScholesGamma(spot, strike, tau, sigma)).toBeCloseTo(expected, 10);
  });

  it('is NaN on bad inputs for both delta and gamma', () => {
    expect(blackScholesDelta(NaN, 100, 0.5, 0.6, true)).toBeNaN();
    expect(blackScholesDelta(100, 100, 0, 0.6, true)).toBeNaN();
    expect(blackScholesDelta(100, 100, 0.5, 0, true)).toBeNaN();
    expect(blackScholesDelta(100, -100, 0.5, 0.6, true)).toBeNaN();
    expect(blackScholesDelta(-100, 100, 0.5, 0.6, true)).toBeNaN();

    expect(blackScholesGamma(NaN, 100, 0.5, 0.6)).toBeNaN();
    expect(blackScholesGamma(100, 100, -0.1, 0.6)).toBeNaN();
    expect(blackScholesGamma(100, 100, 0.5, -0.1)).toBeNaN();
  });
});

describe('fetchDvol', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows continuation backward and returns ascending, deduplicated rows', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            data: [
              [3000, 30, 40, 20, 35],
              [4000, 40, 50, 30, 45],
              [5000, 50, 60, 40, 55],
            ],
            continuation: 3000,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            data: [
              [1000, 10, 20, 5, 15],
              [2000, 20, 30, 15, 25],
              [3000, 30, 40, 20, 35],
            ],
            continuation: null,
          },
        })
      );

    const rows = await fetchDvol('BTC', 1000, 5000, 3600, { retryBaseMs: 0, minGapMs: 0 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.timestamp)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(rows[0]).toEqual({ timestamp: 1000, open: 10, high: 20, low: 5, close: 15 });
    expect(rows[2]).toEqual({ timestamp: 3000, open: 30, high: 40, low: 20, close: 35 });

    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondUrl).toContain('end_timestamp=3000');
  });

  it('stops on an empty page even when continuation is non-null', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ result: { data: [], continuation: 999 } }));

    const rows = await fetchDvol('BTC', 1000, 5000, 3600, { retryBaseMs: 0, minGapMs: 0 });

    expect(rows).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('fetchOptionTrades', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function rawTrade(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      trade_seq: 1,
      trade_id: 't1',
      timestamp: 1000,
      tick_direction: 0,
      price: 0.05,
      mark_price: 0.051,
      iv: 65.2,
      instrument_name: 'BTC-28JAN22-56000-C',
      index_price: 42000,
      direction: 'buy',
      amount: 10,
      contracts: 10,
      ...overrides,
    };
  }

  it('pages backward by the oldest timestamp, dedupes by tradeId, and returns ascending order', async () => {
    const t5 = rawTrade({ trade_id: 't5', trade_seq: 5, timestamp: 5000 });
    const t4 = rawTrade({ trade_id: 't4', trade_seq: 4, timestamp: 4000 });
    const t3 = rawTrade({ trade_id: 't3', trade_seq: 3, timestamp: 3000 });
    const t3dup = rawTrade({ trade_id: 't3', trade_seq: 3, timestamp: 3000 });
    const t2 = rawTrade({ trade_id: 't2', trade_seq: 2, timestamp: 2000 });
    const t1 = rawTrade({ trade_id: 't1', trade_seq: 1, timestamp: 1000 });

    mockFetch
      .mockResolvedValueOnce(jsonResponse({ result: { trades: [t5, t4, t3], has_more: true } }))
      .mockResolvedValueOnce(jsonResponse({ result: { trades: [t3dup, t2, t1], has_more: false } }));

    const trades = await fetchOptionTrades('BTC', 500, 5000, { retryBaseMs: 0, minGapMs: 0 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(trades.map((t) => t.tradeId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(trades[0]).toMatchObject({
      tradeId: 't1',
      tradeSeq: 1,
      instrumentName: 'BTC-28JAN22-56000-C',
      direction: 'buy',
      markPrice: 0.051,
      iv: 65.2,
      indexPrice: 42000,
      amount: 10,
      contracts: 10,
    });

    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondUrl).toContain('end_timestamp=3000');
  });

  it('stops when has_more is false', async () => {
    const t1 = rawTrade({ trade_id: 't1' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ result: { trades: [t1], has_more: false } }));

    const trades = await fetchOptionTrades('BTC', 500, 5000, { retryBaseMs: 0, minGapMs: 0 });

    expect(trades).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stops when a page adds no new ids even though has_more is true', async () => {
    const t1 = rawTrade({ trade_id: 't1' });
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ result: { trades: [t1], has_more: true } }))
      .mockResolvedValueOnce(jsonResponse({ result: { trades: [t1], has_more: true } }));

    const trades = await fetchOptionTrades('BTC', 500, 5000, { retryBaseMs: 0, minGapMs: 0 });

    expect(trades).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('nulls missing mark_price, iv and contracts rather than defaulting to 0', async () => {
    const t1 = rawTrade({ mark_price: null, iv: null, contracts: null });
    mockFetch.mockResolvedValueOnce(jsonResponse({ result: { trades: [t1], has_more: false } }));

    const trades = await fetchOptionTrades('BTC', 500, 5000, { retryBaseMs: 0, minGapMs: 0 });

    expect(trades[0].markPrice).toBeNull();
    expect(trades[0].iv).toBeNull();
    expect(trades[0].contracts).toBeNull();
  });
});

describe('retry behaviour (shared by fetchDvol and fetchOptionTrades)', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okDvol = jsonResponse({
    result: { data: [[1000, 1, 2, 0.5, 1.5]], continuation: null },
  });

  it('retries a 503 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(okDvol);

    const rows = await fetchDvol('BTC', 1000, 2000, 3600, { retryBaseMs: 0, minGapMs: 0 });

    expect(rows).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a network error and succeeds', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(okDvol);

    const rows = await fetchDvol('BTC', 1000, 2000, 3600, { retryBaseMs: 0, minGapMs: 0 });

    expect(rows).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a JSON-RPC 10028 (too_many_requests) and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: { code: 10028, message: 'too_many_requests' } }, 429))
      .mockResolvedValueOnce(okDvol);

    const rows = await fetchDvol('BTC', 1000, 2000, 3600, { retryBaseMs: 0, minGapMs: 0 });

    expect(rows).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after four attempts', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(
      fetchDvol('BTC', 1000, 2000, 3600, { retryBaseMs: 0, minGapMs: 0 })
    ).rejects.toThrow(/HTTP 500/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry a plain HTTP 400', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    await expect(
      fetchDvol('BTC', 1000, 2000, 3600, { retryBaseMs: 0, minGapMs: 0 })
    ).rejects.toThrow(/HTTP 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a JSON-RPC error other than 10028', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: { code: 10009, message: 'invalid_params' } }, 200));

    await expect(
      fetchDvol('BTC', 1000, 2000, 3600, { retryBaseMs: 0, minGapMs: 0 })
    ).rejects.toThrow(/10009/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('minGapMs throttle', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits at least minGapMs between two outgoing requests', async () => {
    // Fresh module instance so the module-level lastRequestAt starts at 0,
    // independent of whatever real time earlier tests in this file ran at.
    const fresh = await import('./deribit');

    vi.useFakeTimers();
    mockFetch.mockResolvedValue(
      jsonResponse({ result: { data: [[1000, 1, 2, 0.5, 1.5]], continuation: null } })
    );

    const first = fresh.fetchDvol('BTC', 1000, 2000, 3600, { retryBaseMs: 0, minGapMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const second = fresh.fetchDvol('BTC', 3000, 4000, 3600, { retryBaseMs: 0, minGapMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await Promise.all([first, second]);
  });
});
