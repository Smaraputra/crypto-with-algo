import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FUTURES_WS_BASE,
  MAX_STREAMS_PER_CONNECTION,
  buildStreamUrl,
  fetchRecorderUniverse,
  isEligiblePerp,
  sameSymbolSet,
  selectTopSymbols,
  type ExchangeSymbol,
} from './symbols';

function perp(symbol: string, overrides: Partial<ExchangeSymbol> = {}): ExchangeSymbol {
  return {
    symbol,
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    underlyingType: 'COIN',
    ...overrides,
  };
}

describe('isEligiblePerp', () => {
  it('accepts a trading USDT-quoted coin perpetual', () => {
    expect(isEligiblePerp(perp('BTCUSDT'))).toBe(true);
  });

  it.each([
    ['a TradFi perpetual', { contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }],
    ['a quarterly future', { contractType: 'CURRENT_QUARTER' }],
    ['a settling (delisted) symbol', { status: 'SETTLING' }],
    ['a USDC-quoted perpetual', { quoteAsset: 'USDC' }],
    ['an index perpetual', { underlyingType: 'INDEX' }],
    ['a pre-market perpetual', { underlyingType: 'PREMARKET' }],
    ['a symbol missing its contract type', { contractType: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(isEligiblePerp(perp('XUSDT', overrides))).toBe(false);
  });
});

describe('selectTopSymbols', () => {
  const exchange = [
    perp('BTCUSDT'),
    perp('ETHUSDT'),
    perp('SOLUSDT'),
    perp('XAUUSDT', { contractType: 'TRADIFI_PERPETUAL', underlyingType: 'COMMODITY' }),
    perp('OLDUSDT', { status: 'SETTLING' }),
    perp('NEWUSDT'),
  ];

  it('ranks eligible symbols by 24h quote volume and keeps the top N', () => {
    const selection = selectTopSymbols(
      exchange,
      [
        { symbol: 'SOLUSDT', quoteVolume: '2000' },
        { symbol: 'BTCUSDT', quoteVolume: '9000' },
        { symbol: 'ETHUSDT', quoteVolume: '5000' },
        // Ineligible symbols never rank, however large their volume.
        { symbol: 'XAUUSDT', quoteVolume: '99999' },
        { symbol: 'OLDUSDT', quoteVolume: '88888' },
        { symbol: 'NOTLISTED', quoteVolume: '77777' },
      ],
      2
    );

    expect(selection.symbols).toEqual([
      { symbol: 'BTCUSDT', quoteVolume: 9000 },
      { symbol: 'ETHUSDT', quoteVolume: 5000 },
    ]);
    expect(selection.eligibleCount).toBe(4);
    expect(selection.topN).toBe(2);
  });

  it('leaves out an eligible symbol with no ticker row or an unreadable volume', () => {
    const selection = selectTopSymbols(
      exchange,
      [
        { symbol: 'BTCUSDT', quoteVolume: '10' },
        { symbol: 'SOLUSDT', quoteVolume: 'n/a' },
      ],
      10
    );

    expect(selection.symbols.map((s) => s.symbol)).toEqual(['BTCUSDT']);
  });

  it('breaks volume ties by symbol so the set is deterministic', () => {
    const selection = selectTopSymbols(
      exchange,
      [
        { symbol: 'SOLUSDT', quoteVolume: '5' },
        { symbol: 'ETHUSDT', quoteVolume: '5' },
      ],
      1
    );

    expect(selection.symbols.map((s) => s.symbol)).toEqual(['ETHUSDT']);
  });
});

describe('sameSymbolSet', () => {
  it('ignores order and compares membership', () => {
    expect(sameSymbolSet(['A', 'B'], ['B', 'A'])).toBe(true);
    expect(sameSymbolSet(['A', 'B'], ['A', 'C'])).toBe(false);
    expect(sameSymbolSet(['A'], ['A', 'B'])).toBe(false);
    expect(sameSymbolSet([], [])).toBe(true);
  });
});

describe('buildStreamUrl', () => {
  it('puts the liquidation stream and one lowercase aggTrade stream per symbol in the URL', () => {
    expect(buildStreamUrl(DEFAULT_FUTURES_WS_BASE, ['BTCUSDT', '1000PEPEUSDT'])).toBe(
      'wss://fstream.binance.com/market/stream?streams=!forceOrder@arr/btcusdt@aggTrade/1000pepeusdt@aggTrade'
    );
  });

  it('tolerates a trailing slash on the base', () => {
    expect(buildStreamUrl('wss://example.test/market/', [])).toBe(
      'wss://example.test/market/stream?streams=!forceOrder@arr'
    );
  });

  it('keeps a non-ASCII symbol, which the URL parser percent-encodes', () => {
    const url = buildStreamUrl(DEFAULT_FUTURES_WS_BASE, ['龙虾USDT']);

    expect(url).toContain('龙虾usdt@aggTrade');
    expect(new URL(url).href).toContain('%E9%BE%99%E8%99%BEusdt@aggTrade');
  });

  it('refuses more streams than one connection allows', () => {
    const symbols = Array.from({ length: MAX_STREAMS_PER_CONNECTION }, (_, i) => `S${i}USDT`);

    expect(() => buildStreamUrl(DEFAULT_FUTURES_WS_BASE, symbols)).toThrow(/exceed/);
  });
});

describe('fetchRecorderUniverse', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('reads exchangeInfo and the 24h ticker from the configured base', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/fapi/v1/exchangeInfo') return jsonResponse({ symbols: [perp('BTCUSDT'), perp('ETHUSDT')] });
      if (path === '/fapi/v1/ticker/24hr') {
        return jsonResponse([
          { symbol: 'BTCUSDT', quoteVolume: '9', lastPrice: '1' },
          { symbol: 'ETHUSDT', quoteVolume: '10', lastPrice: '1' },
        ]);
      }
      return jsonResponse({}, 404);
    });

    const selection = await fetchRecorderUniverse('https://proxy.test/', 5, fetchImpl as unknown as typeof fetch);

    expect(selection.symbols.map((s) => s.symbol)).toEqual(['ETHUSDT', 'BTCUSDT']);
    expect(fetchImpl.mock.calls.map(([u]) => String(u)).sort()).toEqual([
      'https://proxy.test/fapi/v1/exchangeInfo',
      'https://proxy.test/fapi/v1/ticker/24hr',
    ]);
  });

  it('throws on an HTTP failure so the caller keeps its current set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: -1 }, 403));

    await expect(
      fetchRecorderUniverse('https://fapi.binance.com', 5, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/HTTP 403/);
  });

  it('throws on a response of the wrong shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));

    await expect(
      fetchRecorderUniverse('https://fapi.binance.com', 5, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/unexpected shape/);
  });
});
