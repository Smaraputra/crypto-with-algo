// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticker24h } from '@/types/market';

let fetchTickers: typeof import('./binance').fetchTickers;
let fetchKlines: typeof import('./binance').fetchKlines;
let fetchTickerPrices: typeof import('./binance').fetchTickerPrices;
let fetchSymbols: typeof import('./binance').fetchSymbols;

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubEnv('BINANCE_API_URL', 'https://proxy.example.com/api/v3');
  vi.resetModules();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function importModule() {
  const mod = await import('./binance');
  fetchTickers = mod.fetchTickers;
  fetchKlines = mod.fetchKlines;
  fetchTickerPrices = mod.fetchTickerPrices;
  fetchSymbols = mod.fetchSymbols;
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function errorResponse(status: number) {
  return { ok: false, status, json: () => Promise.resolve({}) };
}

describe('base URL configuration', () => {
  it('uses BINANCE_API_URL env var when set', async () => {
    vi.stubEnv('BINANCE_API_URL', 'https://custom-proxy.test/api/v3');
    await importModule();
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchTickers();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom-proxy.test/api/v3/ticker/24hr'
    );
  });

  it('falls back to default Binance URL when env var is unset', async () => {
    vi.stubEnv('BINANCE_API_URL', '');
    await importModule();
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchTickers();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.binance.com/api/v3/ticker/24hr'
    );
  });
});

describe('fetchTickers', () => {
  beforeEach(async () => {
    await importModule();
  });

  it('returns parsed tickers', async () => {
    const tickers: Ticker24h[] = [
      {
        symbol: 'BTCUSDT',
        lastPrice: '50000.00',
        priceChange: '1000.00',
        priceChangePercent: '2.04',
        highPrice: '51000.00',
        lowPrice: '49000.00',
        volume: '12345.67',
        quoteVolume: '617283500.00',
        openPrice: '49000.00',
        count: 100000,
      },
    ];
    mockFetch.mockResolvedValue(okResponse(tickers));

    const result = await fetchTickers();

    expect(result).toEqual(tickers);
  });

  it('filters to USDT pairs only', async () => {
    const tickers = [
      { symbol: 'BTCUSDT', lastPrice: '50000' },
      { symbol: 'ETHBTC', lastPrice: '0.065' },
      { symbol: 'ETHUSDT', lastPrice: '3200' },
      { symbol: 'BNBBUSD', lastPrice: '300' },
    ];
    mockFetch.mockResolvedValue(okResponse(tickers));

    const result = await fetchTickers();

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(403));

    await expect(fetchTickers()).rejects.toThrow(
      'Failed to fetch tickers: HTTP 403'
    );
  });

  it('throws on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    await expect(fetchTickers()).rejects.toThrow('fetch failed');
  });
});

describe('fetchKlines', () => {
  beforeEach(async () => {
    await importModule();
  });

  it('returns parsed OHLCV with correct float conversion', async () => {
    const rawKlines = [
      [1700000000000, '50000.12', '51000.34', '49000.56', '50500.78', '123.456'],
    ];
    mockFetch.mockResolvedValue(okResponse(rawKlines));

    const result = await fetchKlines('BTCUSDT', '1h');

    expect(result).toEqual([
      {
        timestamp: 1700000000000,
        open: 50000.12,
        high: 51000.34,
        low: 49000.56,
        close: 50500.78,
        volume: 123.456,
      },
    ]);
  });

  it('defaults limit to 500', async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchKlines('BTCUSDT', '1h');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('limit=500')
    );
  });

  it('respects custom limit parameter', async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchKlines('BTCUSDT', '1h', 100);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('limit=100')
    );
  });

  it('passes symbol and interval as query params', async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchKlines('ETHUSDT', '4h', 200);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('symbol=ETHUSDT');
    expect(url).toContain('interval=4h');
    expect(url).toContain('limit=200');
  });

  it('passes startTime when provided', async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchKlines('BTCUSDT', '1h', 500, 1700000000000);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('startTime=1700000000000');
    expect(url).not.toContain('endTime');
  });

  it('passes startTime and endTime when both provided', async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchKlines('BTCUSDT', '1h', 500, 1700000000000, 1700100000000);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('startTime=1700000000000');
    expect(url).toContain('endTime=1700100000000');
  });

  it('omits startTime and endTime when not provided', async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await fetchKlines('BTCUSDT', '1h');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('startTime');
    expect(url).not.toContain('endTime');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(429));

    await expect(fetchKlines('BTCUSDT', '1h')).rejects.toThrow(
      'Failed to fetch klines for BTCUSDT: HTTP 429'
    );
  });
});

describe('fetchTickerPrices', () => {
  beforeEach(async () => {
    await importModule();
  });

  it('returns empty object for empty symbols array', async () => {
    const result = await fetchTickerPrices([]);
    expect(result).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns price map for given symbols', async () => {
    mockFetch.mockResolvedValue(
      okResponse([
        { symbol: 'BTCUSDT', price: '100000.50' },
        { symbol: 'ETHUSDT', price: '3500.25' },
      ])
    );

    const result = await fetchTickerPrices(['BTCUSDT', 'ETHUSDT']);

    expect(result).toEqual({ BTCUSDT: 100000.5, ETHUSDT: 3500.25 });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('ticker/price');
    expect(url).toContain('symbols=');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(403));

    await expect(fetchTickerPrices(['BTCUSDT'])).rejects.toThrow(
      'Failed to fetch ticker prices: HTTP 403'
    );
  });
});

describe('fetchSymbols', () => {
  beforeEach(async () => {
    await importModule();
  });

  it('returns filtered symbols', async () => {
    const exchangeInfo = {
      symbols: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
      ],
    };
    mockFetch.mockResolvedValue(okResponse(exchangeInfo));

    const result = await fetchSymbols();

    expect(result).toEqual([
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
    ]);
  });

  it('filters by TRADING status and USDT quote asset', async () => {
    const exchangeInfo = {
      symbols: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
        { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING' },
        { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT', status: 'BREAK' },
        { symbol: 'BNBBUSD', baseAsset: 'BNB', quoteAsset: 'BUSD', status: 'TRADING' },
      ],
    };
    mockFetch.mockResolvedValue(okResponse(exchangeInfo));

    const result = await fetchSymbols();

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('BTCUSDT');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(500));

    await expect(fetchSymbols()).rejects.toThrow(
      'Failed to fetch exchange info: HTTP 500'
    );
  });
});
