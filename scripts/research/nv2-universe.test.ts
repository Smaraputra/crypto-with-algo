// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { fetchPerpKlinesRange, PerpKline } from '@/lib/binance-futures';
import { buildUniverse, parseArgs } from './nv2-universe';

const DAY_MS = 86_400_000;

function makeKline(openTime: number, quoteVolume: number): PerpKline {
  return {
    openTime,
    closeTime: openTime + DAY_MS - 1,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1000,
    quoteVolume,
    trades: 50,
    takerBuyVolume: 500,
  };
}

function makeKlines(asOfMs: number, count: number, quoteVolume: number): PerpKline[] {
  const lastOpenTime = asOfMs - DAY_MS;
  const firstOpenTime = lastOpenTime - (count - 1) * DAY_MS;
  return Array.from({ length: count }, (_, i) => makeKline(firstOpenTime + i * DAY_MS, quoteVolume));
}

function makeSymbolEntry(symbol: string, baseAsset: string, overrides: Record<string, unknown> = {}) {
  return {
    symbol,
    pair: symbol,
    contractType: 'PERPETUAL',
    underlyingType: 'COIN',
    quoteAsset: 'USDT',
    baseAsset,
    status: 'TRADING',
    onboardDate: 1567965300000,
    deliveryDate: 4133404800000,
    filters: [],
    ...overrides,
  };
}

const FIXTURE_EXCHANGE_INFO = {
  symbols: [
    makeSymbolEntry('USDCUSDT', 'USDC'),
    makeSymbolEntry('SHORTUSDT', 'SHORT'),
    makeSymbolEntry('ETHUSDT', 'ETH'),
    makeSymbolEntry('BTCUSDT', 'BTC'),
  ],
};

describe('parseArgs', () => {
  it('rejects a missing --out', () => {
    expect(() =>
      parseArgs(['--as-of', '2026-10-20', '--exchange-info', 'fixture.json'])
    ).toThrow(/--out/);
  });

  it('parses valid args and sets default top to 30 and delayMs to 400', () => {
    const args = parseArgs([
      '--as-of',
      '2026-10-20',
      '--exchange-info',
      'fixture.json',
      '--out',
      'out.json',
    ]);
    expect(args).toEqual({
      asOf: '2026-10-20',
      top: 30,
      exchangeInfo: 'fixture.json',
      out: 'out.json',
      delayMs: 400,
    });
  });

  it('parses custom top and delayMs', () => {
    const args = parseArgs([
      '--as-of',
      '2026-10-20',
      '--top',
      '10',
      '--exchange-info',
      'fixture.json',
      '--out',
      'out.json',
      '--delay-ms',
      '250',
    ]);
    expect(args.top).toBe(10);
    expect(args.delayMs).toBe(250);
  });
});

describe('buildUniverse', () => {
  const asOf = '2026-10-20';
  const asOfMs = Date.parse(`${asOf}T00:00:00.000Z`);
  const noopSleep = async () => {};

  it('excludes a stablecoin base (USDCUSDT)', async () => {
    const fetchedSymbols: string[] = [];
    const fakeFetch: typeof fetchPerpKlinesRange = async (symbol) => {
      fetchedSymbols.push(symbol);
      return makeKlines(asOfMs, 400, 1_000_000);
    };

    const result = await buildUniverse({
      asOfMs,
      top: 30,
      exchangeInfo: FIXTURE_EXCHANGE_INFO,
      fetchKlines: fakeFetch,
      sleep: noopSleep,
      delayMs: 0,
    });

    expect(result.candidates).not.toContain('USDCUSDT');
    expect(fetchedSymbols).not.toContain('USDCUSDT');
    expect(result.members.map((m) => m.symbol)).not.toContain('USDCUSDT');
  });

  it('prefilters a symbol whose onboardDate is less than 366 days old without fetching', async () => {
    const fetchedSymbols: string[] = [];
    const recentOnboardMs = asOfMs - 100 * DAY_MS;
    const infoWithNewSymbol = {
      symbols: [
        makeSymbolEntry('BTCUSDT', 'BTC'),
        makeSymbolEntry('NEWCOINUSDT', 'NEWCOIN', { onboardDate: recentOnboardMs }),
      ],
    };

    const fakeFetch: typeof fetchPerpKlinesRange = async (symbol) => {
      fetchedSymbols.push(symbol);
      return makeKlines(asOfMs, 400, 1_000_000);
    };

    const result = await buildUniverse({
      asOfMs,
      top: 30,
      exchangeInfo: infoWithNewSymbol,
      fetchKlines: fakeFetch,
      sleep: noopSleep,
      delayMs: 0,
    });

    expect(result.skippedTooNew).toBe(1);
    expect(result.candidates).not.toContain('NEWCOINUSDT');
    expect(fetchedSymbols).not.toContain('NEWCOINUSDT');
  });

  it('aborts immediately when a fetch encounters an HTTP 418 or -1003 error', async () => {
    const fetchedSymbols: string[] = [];
    const fakeFetch: typeof fetchPerpKlinesRange = async (symbol) => {
      fetchedSymbols.push(symbol);
      throw new Error('HTTP 418 Way too many requests; IP banned code: -1003');
    };

    await expect(
      buildUniverse({
        asOfMs,
        top: 30,
        exchangeInfo: FIXTURE_EXCHANGE_INFO,
        fetchKlines: fakeFetch,
        sleep: noopSleep,
        delayMs: 0,
      })
    ).rejects.toThrow(/Binance rate limit encountered/);

    expect(fetchedSymbols).toHaveLength(1);
  });

  it('fetches symbols sequentially with concurrency never exceeding 1', async () => {
    let currentConcurrency = 0;
    let maxConcurrency = 0;

    const fakeFetch: typeof fetchPerpKlinesRange = async () => {
      currentConcurrency++;
      if (currentConcurrency > maxConcurrency) maxConcurrency = currentConcurrency;
      await new Promise((resolve) => setTimeout(resolve, 5));
      currentConcurrency--;
      return makeKlines(asOfMs, 400, 1_000_000);
    };

    await buildUniverse({
      asOfMs,
      top: 30,
      exchangeInfo: FIXTURE_EXCHANGE_INFO,
      fetchKlines: fakeFetch,
      sleep: noopSleep,
      delayMs: 1,
    });

    expect(maxConcurrency).toBe(1);
  });

  it('does not rank a symbol with only 300 daily bars', async () => {
    const fakeFetch: typeof fetchPerpKlinesRange = async (symbol) => {
      if (symbol === 'SHORTUSDT') {
        return makeKlines(asOfMs, 300, 500_000);
      }
      return makeKlines(asOfMs, 400, 1_000_000);
    };

    const result = await buildUniverse({
      asOfMs,
      top: 30,
      exchangeInfo: FIXTURE_EXCHANGE_INFO,
      fetchKlines: fakeFetch,
      sleep: noopSleep,
      delayMs: 0,
    });

    expect(result.candidates).toContain('SHORTUSDT');
    expect(result.members.map((m) => m.symbol)).not.toContain('SHORTUSDT');
  });

  it('orders two eligible symbols by their median quote volume', async () => {
    const fakeFetch: typeof fetchPerpKlinesRange = async (symbol) => {
      if (symbol === 'SHORTUSDT') {
        return makeKlines(asOfMs, 300, 500_000);
      }
      if (symbol === 'BTCUSDT') {
        return makeKlines(asOfMs, 400, 5_000_000);
      }
      if (symbol === 'ETHUSDT') {
        return makeKlines(asOfMs, 400, 2_000_000);
      }
      return [];
    };

    const result = await buildUniverse({
      asOfMs,
      top: 30,
      exchangeInfo: FIXTURE_EXCHANGE_INFO,
      fetchKlines: fakeFetch,
      sleep: noopSleep,
      delayMs: 0,
    });

    expect(result.members).toHaveLength(2);
    expect(result.members[0]).toEqual({
      rank: 1,
      symbol: 'BTCUSDT',
      assetKey: 'BTC',
      medianQuoteVolume: 5_000_000,
    });
    expect(result.members[1]).toEqual({
      rank: 2,
      symbol: 'ETHUSDT',
      assetKey: 'ETH',
      medianQuoteVolume: 2_000_000,
    });
  });

  it('places a symbol whose fetch throws twice in failed with its reason', async () => {
    let shortAttempts = 0;
    const fakeFetch: typeof fetchPerpKlinesRange = async (symbol) => {
      if (symbol === 'SHORTUSDT') {
        shortAttempts++;
        throw new Error('Network timeout');
      }
      if (symbol === 'BTCUSDT') {
        return makeKlines(asOfMs, 400, 5_000_000);
      }
      if (symbol === 'ETHUSDT') {
        return makeKlines(asOfMs, 400, 2_000_000);
      }
      return [];
    };

    const result = await buildUniverse({
      asOfMs,
      top: 30,
      exchangeInfo: FIXTURE_EXCHANGE_INFO,
      fetchKlines: fakeFetch,
      sleep: noopSleep,
      delayMs: 0,
    });

    expect(shortAttempts).toBe(2);
    expect(result.failed).toEqual(['SHORTUSDT']);
    expect(result.failedReasons['SHORTUSDT']).toBe('Network timeout');
    expect(result.members.map((m) => m.symbol)).not.toContain('SHORTUSDT');
  });

  it('recovers if fetch succeeds on the second attempt', async () => {
    let btcAttempts = 0;
    const fakeFetch: typeof fetchPerpKlinesRange = async (symbol) => {
      if (symbol === 'BTCUSDT') {
        btcAttempts++;
        if (btcAttempts === 1) throw new Error('Temporary glitch');
        return makeKlines(asOfMs, 400, 5_000_000);
      }
      if (symbol === 'ETHUSDT') {
        return makeKlines(asOfMs, 400, 2_000_000);
      }
      return [];
    };

    const result = await buildUniverse({
      asOfMs,
      top: 30,
      exchangeInfo: FIXTURE_EXCHANGE_INFO,
      fetchKlines: fakeFetch,
      sleep: noopSleep,
      delayMs: 0,
    });

    expect(btcAttempts).toBe(2);
    expect(result.failed).not.toContain('BTCUSDT');
    expect(result.members.some((m) => m.symbol === 'BTCUSDT')).toBe(true);
  });
});
