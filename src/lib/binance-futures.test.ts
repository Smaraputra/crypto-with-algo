import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BinanceHttpError,
  fetchDepth,
  fetchFundingInfo,
  fetchPerpExchangeInfo,
  fetchPerpKlines,
  fetchPremiumIndex,
  fetchFundingRate,
  fetchGlobalLongShortRatio,
  fetchLongShortRatio,
  fetchOpenInterest,
  fetchOpenInterestHistory,
} from './binance-futures';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockError(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
  });
}

describe('fetchFundingRate', () => {
  it('fetches and parses funding rate', async () => {
    mockOk([
      {
        symbol: 'BTCUSDT',
        fundingRate: '0.00010000',
        fundingTime: 1700000000000,
        markPrice: '43000.50000000',
      },
    ]);

    const result = await fetchFundingRate('BTCUSDT');

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('BTCUSDT');
    expect(result[0].fundingRate).toBeCloseTo(0.0001);
    expect(result[0].markPrice).toBeCloseTo(43000.5);
    expect(result[0].fundingTime).toBe(1700000000000);
  });

  it('passes limit parameter', async () => {
    mockOk([]);
    await fetchFundingRate('ETHUSDT', 5);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('limit=5');
    expect(url).toContain('symbol=ETHUSDT');
  });

  it('throws on HTTP error', async () => {
    mockError(403);
    await expect(fetchFundingRate('BTCUSDT')).rejects.toThrow('HTTP 403');
  });

  it('uses default base URL', async () => {
    mockOk([]);
    await fetchFundingRate('BTCUSDT');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('fapi.binance.com');
  });

  it('uses env var for base URL', async () => {
    vi.stubEnv('BINANCE_FUTURES_API_URL', 'https://proxy.example.com');
    mockOk([]);
    await fetchFundingRate('BTCUSDT');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('proxy.example.com');
  });
});

describe('fetchOpenInterest', () => {
  it('fetches and parses open interest', async () => {
    mockOk({
      symbol: 'BTCUSDT',
      openInterest: '12345.678',
      time: 1700000000000,
    });

    const result = await fetchOpenInterest('BTCUSDT');

    expect(result.symbol).toBe('BTCUSDT');
    expect(result.openInterest).toBeCloseTo(12345.678);
    expect(result.time).toBe(1700000000000);
  });

  it('throws on HTTP error', async () => {
    mockError(500);
    await expect(fetchOpenInterest('BTCUSDT')).rejects.toThrow('HTTP 500');
  });
});

describe('fetchOpenInterestHistory', () => {
  it('fetches and parses OI history', async () => {
    mockOk([
      {
        symbol: 'BTCUSDT',
        sumOpenInterest: '12345.678',
        sumOpenInterestValue: '530000000.12',
        timestamp: 1700000000000,
      },
      {
        symbol: 'BTCUSDT',
        sumOpenInterest: '12400.000',
        sumOpenInterestValue: '533000000.00',
        timestamp: 1700000300000,
      },
    ]);

    const result = await fetchOpenInterestHistory('BTCUSDT', '5m', 2);

    expect(result).toHaveLength(2);
    expect(result[0].sumOpenInterest).toBeCloseTo(12345.678);
    expect(result[1].sumOpenInterestValue).toBeCloseTo(533000000);
  });

  it('passes period and limit', async () => {
    mockOk([]);
    await fetchOpenInterestHistory('ETHUSDT', '1h', 10);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('period=1h');
    expect(url).toContain('limit=10');
  });

  it('throws on HTTP error', async () => {
    mockError(403);
    await expect(fetchOpenInterestHistory('BTCUSDT')).rejects.toThrow('HTTP 403');
  });
});

describe('fetchLongShortRatio', () => {
  it('fetches and parses L/S ratio', async () => {
    mockOk([
      {
        symbol: 'BTCUSDT',
        longShortRatio: '1.2345',
        longAccount: '0.5525',
        shortAccount: '0.4475',
        timestamp: 1700000000000,
      },
    ]);

    const result = await fetchLongShortRatio('BTCUSDT');

    expect(result).toHaveLength(1);
    expect(result[0].longShortRatio).toBeCloseTo(1.2345);
    expect(result[0].longAccount).toBeCloseTo(0.5525);
    expect(result[0].shortAccount).toBeCloseTo(0.4475);
  });

  it('passes period and limit', async () => {
    mockOk([]);
    await fetchLongShortRatio('BTCUSDT', '4h', 5);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('period=4h');
    expect(url).toContain('limit=5');
  });

  it('throws on HTTP error', async () => {
    mockError(429);
    await expect(fetchLongShortRatio('BTCUSDT')).rejects.toThrow('HTTP 429');
  });
});

describe('fetchGlobalLongShortRatio', () => {
  it('fetches and parses global L/S ratio', async () => {
    mockOk([
      {
        symbol: 'BTCUSDT',
        longShortRatio: '0.9876',
        longAccount: '0.4970',
        shortAccount: '0.5030',
        timestamp: 1700000000000,
      },
    ]);

    const result = await fetchGlobalLongShortRatio('BTCUSDT');

    expect(result).toHaveLength(1);
    expect(result[0].longShortRatio).toBeCloseTo(0.9876);
  });

  it('uses globalLongShortAccountRatio endpoint', async () => {
    mockOk([]);
    await fetchGlobalLongShortRatio('BTCUSDT');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('globalLongShortAccountRatio');
  });

  it('throws on HTTP error', async () => {
    mockError(503);
    await expect(fetchGlobalLongShortRatio('BTCUSDT')).rejects.toThrow('HTTP 503');
  });
});

describe('cost check fetchers', () => {
  it('maps a 429 to BinanceHttpError with status and Retry-After', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '12' }),
    });
    const error = await fetchPremiumIndex('BTCUSDT').catch((e) => e);
    expect(error).toBeInstanceOf(BinanceHttpError);
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe('12');
  });

  it('carries a null Retry-After when the header is absent', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 451, headers: new Headers() });
    const error = await fetchPerpExchangeInfo().catch((e) => e);
    expect(error).toBeInstanceOf(BinanceHttpError);
    expect(error.status).toBe(451);
    expect(error.retryAfter).toBeNull();
    expect(error.message).not.toContain('{');
  });

  it('sends a timeout signal', async () => {
    mockOk({ symbols: [] });
    await fetchPerpExchangeInfo();
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('parses klines into rows', async () => {
    mockOk([[1000, '1.5', '2', '1', '1.8', '10', 1999, '18.5', 3, '5', '9', '0']]);
    const rows = await fetchPerpKlines('BTCUSDT', '15m');
    expect(String(mockFetch.mock.calls[0][0])).toContain('interval=15m');
    expect(String(mockFetch.mock.calls[0][0])).toContain('limit=1000');
    expect(rows).toEqual([
      { openTime: 1000, closeTime: 1999, open: 1.5, high: 2, low: 1, close: 1.8, quoteVolume: 18.5 },
    ]);
  });

  it('parses the premium index', async () => {
    mockOk({ markPrice: '100.5', lastFundingRate: '0.0001', nextFundingTime: 123 });
    expect(await fetchPremiumIndex('BTCUSDT')).toEqual({
      markPrice: 100.5,
      lastFundingRate: 0.0001,
      nextFundingTime: 123,
    });
  });

  it('maps fundingInfo to a symbol to hours record', async () => {
    mockOk([{ symbol: 'XUSDT', fundingIntervalHours: 4 }]);
    expect(await fetchFundingInfo()).toEqual({ XUSDT: 4 });
  });

  it('parses depth levels to numbers', async () => {
    mockOk({ bids: [['99', '2']], asks: [['101', '3']] });
    expect(await fetchDepth('BTCUSDT')).toEqual({ bids: [[99, 2]], asks: [[101, 3]] });
  });
});
