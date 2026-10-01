// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { DemoClientOptions } from './binance-demo';
import {
  BinanceDemoClient,
  DEMO_BASE_URL,
  DemoExecutionError,
  WritesDisabledError,
  roundToStep,
  roundToTick,
} from './binance-demo';

const KEY = 'demo-key-aaaaaaaaaaaaaaaa';
const SECRET = 'demo-secret-bbbbbbbbbbbbbbbb';

/** A fetch stub that records calls and replies with `body`. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const impl = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({
      url: String(url),
      method: options?.method ?? 'GET',
      headers: (options?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(over: Partial<DemoClientOptions> = {}, body: unknown = {}) {
  const { impl, calls } = stubFetch(body);
  const c = new BinanceDemoClient({ apiKey: KEY, apiSecret: SECRET, fetchImpl: impl, ...over });
  return { c, calls };
}

describe('the host allowlist', () => {
  it('accepts the demo host', () => {
    expect(() => new BinanceDemoClient({ apiKey: KEY, apiSecret: SECRET })).not.toThrow();
    expect(() => new BinanceDemoClient({ apiKey: KEY, apiSecret: SECRET, baseUrl: DEMO_BASE_URL })).not.toThrow();
  });

  it('refuses the LIVE host, which is the whole point', () => {
    expect(
      () => new BinanceDemoClient({ apiKey: KEY, apiSecret: SECRET, baseUrl: 'https://fapi.binance.com' })
    ).toThrow(/Refusing to build a demo client for https:\/\/fapi\.binance\.com/);
  });

  it('refuses hosts that merely look close', () => {
    for (const host of [
      'https://fapi.binance.com',
      'http://demo-fapi.binance.com',
      'https://demo-fapi.binance.com/',
      'https://demo-fapi.binance.com.evil.test',
      'https://demo-api.binance.com',
      '',
    ]) {
      expect(() => new BinanceDemoClient({ apiKey: KEY, apiSecret: SECRET, baseUrl: host })).toThrow();
    }
  });

  it('refuses to build without both credentials', () => {
    expect(() => new BinanceDemoClient({ apiKey: '', apiSecret: SECRET })).toThrow(/needs both/);
    expect(() => new BinanceDemoClient({ apiKey: KEY, apiSecret: '' })).toThrow(/needs both/);
  });
});

describe('fromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns null when either variable is missing', () => {
    delete process.env.BINANCE_DEMO_API_KEY;
    delete process.env.BINANCE_DEMO_API_SECRET;
    expect(BinanceDemoClient.fromEnv()).toBeNull();
    process.env.BINANCE_DEMO_API_KEY = KEY;
    expect(BinanceDemoClient.fromEnv()).toBeNull();
  });

  it('builds a read-only client by default', () => {
    process.env.BINANCE_DEMO_API_KEY = KEY;
    process.env.BINANCE_DEMO_API_SECRET = SECRET;
    const c = BinanceDemoClient.fromEnv();
    expect(c).not.toBeNull();
    expect(c!.writesEnabled).toBe(false);
  });
});

describe('writes are refused unless explicitly enabled', () => {
  it('throws on every ordering method while disabled, without calling fetch', async () => {
    const { c, calls } = client();
    await expect(c.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001 })).rejects.toThrow(
      WritesDisabledError
    );
    await expect(
      c.conditionalOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: 1, quantity: 0.001 })
    ).rejects.toThrow(WritesDisabledError);
    await expect(c.cancelAlgoOrder('BTCUSDT', 1)).rejects.toThrow(WritesDisabledError);
    await expect(c.cancelAllOpenOrders('BTCUSDT')).rejects.toThrow(WritesDisabledError);
    await expect(c.setLeverage('BTCUSDT', 5)).rejects.toThrow(WritesDisabledError);
    expect(calls).toHaveLength(0);
  });

  it('allows reads while writes are disabled', async () => {
    const { c, calls } = client({}, []);
    await c.openPositions();
    expect(calls).toHaveLength(1);
  });
});

describe('signing', () => {
  it('signs the query with HMAC-SHA256 and sends the key as a header', async () => {
    const { c, calls } = client({}, []);
    await c.openPositions();

    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(`${DEMO_BASE_URL}/fapi/v3/positionRisk`);
    expect(calls[0].headers['X-MBX-APIKEY']).toBe(KEY);

    const signature = url.searchParams.get('signature')!;
    url.searchParams.delete('signature');
    const expected = createHmac('sha256', SECRET).update(url.searchParams.toString()).digest('hex');
    expect(signature).toBe(expected);
    expect(url.searchParams.get('recvWindow')).toBe('5000');
    expect(Number(url.searchParams.get('timestamp'))).toBeGreaterThan(0);
  });

  it('does not sign or key public endpoints', async () => {
    const { c, calls } = client({}, { symbols: [] });
    await c.venueFilters();
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('signature')).toBeNull();
    expect(calls[0].headers['X-MBX-APIKEY']).toBeUndefined();
  });
});

describe('credentials never leak into errors', () => {
  it('redacts the key, the secret and the signature', () => {
    const { c } = client();
    const text = `boom key=${KEY} secret=${SECRET} signature=deadBEEF1234`;
    const out = c.redact(text);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(SECRET);
    expect(out).not.toMatch(/signature=[0-9a-f]+/i);
    expect(out).toContain('[redacted]');
  });

  it('redacts a signed URL echoed back in an API error', async () => {
    const { impl } = stubFetch(
      { code: -1022, msg: `Signature for this request is not valid: signature=abc123 key ${KEY}` },
      { ok: false, status: 400 }
    );
    const c = new BinanceDemoClient({ apiKey: KEY, apiSecret: SECRET, fetchImpl: impl });
    const error = (await c.openPositions().catch((e) => e)) as DemoExecutionError;
    expect(error).toBeInstanceOf(DemoExecutionError);
    expect(error.code).toBe(-1022);
    expect(error.status).toBe(400);
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toMatch(/signature=[0-9a-f]+/i);
  });

  it('surfaces the -4120 code that means a conditional order went to the wrong endpoint', async () => {
    const { impl } = stubFetch({ code: -4120, msg: 'STOP_ORDER_SWITCH_ALGO' }, { ok: false, status: 400 });
    const c = new BinanceDemoClient({ apiKey: KEY, apiSecret: SECRET, fetchImpl: impl, writesEnabled: true });
    const error = (await c
      .marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001 })
      .catch((e) => e)) as DemoExecutionError;
    expect(error.code).toBe(-4120);
  });
});

describe('order shapes', () => {
  it('sends a market order with reduceOnly as a string', async () => {
    const { c, calls } = client({ writesEnabled: true }, { orderId: 1, status: 'NEW' });
    await c.marketOrder({ symbol: 'BTCUSDT', side: 'SELL', quantity: 0.002, reduceOnly: true });
    const q = new URL(calls[0].url).searchParams;
    expect(calls[0].method).toBe('POST');
    expect(new URL(calls[0].url).pathname).toBe('/fapi/v1/order');
    expect(q.get('type')).toBe('MARKET');
    expect(q.get('side')).toBe('SELL');
    expect(q.get('quantity')).toBe('0.002');
    expect(q.get('reduceOnly')).toBe('true');
  });

  it('omits reduceOnly entirely when it is not an exit', async () => {
    const { c, calls } = client({ writesEnabled: true }, { orderId: 1, status: 'NEW' });
    await c.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001 });
    expect(new URL(calls[0].url).searchParams.get('reduceOnly')).toBeNull();
  });

  it('places a stop through the algo endpoint with algoType and triggerPrice', async () => {
    const { c, calls } = client({ writesEnabled: true }, { algoId: 99 });
    await c.conditionalOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      triggerPrice: 76000.1,
      quantity: 0.003,
      clientAlgoId: 'desk-1h-BTCUSDT-stop',
    });
    const url = new URL(calls[0].url);
    const q = url.searchParams;
    // The endpoint and field names are the 2025-12-09 migration's, not the old ones.
    expect(url.pathname).toBe('/fapi/v1/algoOrder');
    expect(q.get('algoType')).toBe('CONDITIONAL');
    expect(q.get('type')).toBe('STOP_MARKET');
    expect(q.get('triggerPrice')).toBe('76000.1');
    expect(q.get('stopPrice')).toBeNull();
    expect(q.get('reduceOnly')).toBe('true');
    expect(q.get('workingType')).toBe('CONTRACT_PRICE');
    expect(q.get('clientAlgoId')).toBe('desk-1h-BTCUSDT-stop');
    // reduceOnly and closePosition cannot be combined, so closePosition is never sent.
    expect(q.get('closePosition')).toBeNull();
  });

  it('cancels an algo order by algoId', async () => {
    const { c, calls } = client({ writesEnabled: true }, {});
    await c.cancelAlgoOrder('BTCUSDT', 4242);
    expect(calls[0].method).toBe('DELETE');
    expect(new URL(calls[0].url).pathname).toBe('/fapi/v1/algoOrder');
    expect(new URL(calls[0].url).searchParams.get('algoId')).toBe('4242');
  });
});

describe('reads', () => {
  it('parses the demo venue filters and keeps only perpetuals', async () => {
    const { c } = client({}, {
      symbols: [
        {
          symbol: 'BTCUSDT',
          status: 'TRADING',
          contractType: 'PERPETUAL',
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.0001', minQty: '0.0001' },
            { filterType: 'MIN_NOTIONAL', notional: '50' },
            { filterType: 'PRICE_FILTER', tickSize: '0.10' },
          ],
        },
        {
          symbol: 'BTCUSDT_260327',
          status: 'TRADING',
          contractType: 'NEXT_QUARTER',
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
            { filterType: 'MIN_NOTIONAL', notional: '50' },
            { filterType: 'PRICE_FILTER', tickSize: '0.10' },
          ],
        },
      ],
    });
    const filters = await c.venueFilters();
    expect([...filters.keys()]).toEqual(['BTCUSDT']);
    // The demo step is finer than live's 0.001, which is why it is read at runtime.
    expect(filters.get('BTCUSDT')).toEqual({
      symbol: 'BTCUSDT',
      status: 'TRADING',
      stepSize: 0.0001,
      minQty: 0.0001,
      minNotional: 50,
      tickSize: 0.1,
    });
  });

  it('reads permissions from v2, where they actually live', async () => {
    const { c, calls } = client({}, { canTrade: true, feeTier: 0, multiAssetsMargin: false });
    expect(await c.permissions()).toEqual({ canTrade: true, feeTier: 0, multiAssetsMargin: false });
    expect(new URL(calls[0].url).pathname).toBe('/fapi/v2/account');
  });

  it('reports one-way mode from positionSide/dual', async () => {
    const oneWay = client({}, { dualSidePosition: false });
    expect(await oneWay.c.isOneWayMode()).toBe(true);
    const hedge = client({}, { dualSidePosition: true });
    expect(await hedge.c.isOneWayMode()).toBe(false);
  });

  it('drops flat rows from positionRisk and handles either unrealised spelling', async () => {
    const { c } = client({}, [
      { symbol: 'BTCUSDT', positionAmt: '0.002', entryPrice: '76000', unRealizedProfit: '1.5' },
      { symbol: 'ETHUSDT', positionAmt: '0', entryPrice: '0', unRealizedProfit: '0' },
      { symbol: 'SOLUSDT', positionAmt: '-3', entryPrice: '200', unrealizedProfit: '-2' },
    ]);
    const open = await c.openPositions();
    expect(open).toEqual([
      { symbol: 'BTCUSDT', positionAmt: 0.002, entryPrice: 76000, unrealizedProfit: 1.5 },
      { symbol: 'SOLUSDT', positionAmt: -3, entryPrice: 200, unrealizedProfit: -2 },
    ]);
  });

  it('accepts either shape the algo list can come back as', async () => {
    const asArray = client({}, [{ algoId: 1, clientAlgoId: 'a', symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '1', quantity: '2' }]);
    expect(await asArray.c.openAlgoOrders()).toHaveLength(1);
    const wrapped = client({}, { orders: [{ algoId: 2, symbol: 'ETHUSDT', side: 'BUY', type: 'TAKE_PROFIT_MARKET', triggerPrice: '3', origQty: '4' }] });
    const rows = await wrapped.c.openAlgoOrders();
    expect(rows[0]).toMatchObject({ algoId: 2, symbol: 'ETHUSDT', quantity: 4 });
  });

  it('parses fills, which is how the mirror learns what it really paid', async () => {
    const { c, calls } = client({}, [
      {
        id: '7',
        orderId: '11',
        symbol: 'BTCUSDT',
        side: 'BUY',
        price: '76010.5',
        qty: '0.002',
        realizedPnl: '0',
        commission: '0.0760105',
        commissionAsset: 'USDT',
        time: '1790000000000',
      },
    ]);
    const fills = await c.userTrades('BTCUSDT', 1790000000000);
    expect(fills[0]).toMatchObject({ price: 76010.5, qty: 0.002, commission: 0.0760105 });
    expect(new URL(calls[0].url).searchParams.get('startTime')).toBe('1790000000000');
  });
});

describe('rounding to the venue grid', () => {
  it('rounds quantity down, never up', () => {
    expect(roundToStep(0.00129, 0.0001)).toBe(0.0012);
    expect(roundToStep(12.99, 1)).toBe(12);
    expect(roundToStep(0.3, 0.1)).toBe(0.3);
  });

  it('returns 0 below one step or for nonsense input', () => {
    expect(roundToStep(0.00009, 0.0001)).toBe(0);
    expect(roundToStep(-1, 0.001)).toBe(0);
    expect(roundToStep(Number.NaN, 0.001)).toBe(0);
    expect(roundToStep(1, 0)).toBe(0);
  });

  it('rounds price to the nearest tick without binary noise', () => {
    expect(roundToTick(76000.17, 0.1)).toBe(76000.2);
    expect(roundToTick(0.123456, 0.00001)).toBe(0.12346);
    expect(roundToTick(5, 0)).toBe(5);
  });
});
