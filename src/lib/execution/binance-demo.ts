import { createHmac } from 'node:crypto';

/**
 * A signed client for the Binance USDⓈ-M futures DEMO venue.
 *
 * Three safety properties, each enforced in the constructor rather than left
 * to a caller's discipline, because this is the only code in the repository
 * that can move a position:
 *
 *  1. **Host allowlist.** The base URL must be exactly
 *     `https://demo-fapi.binance.com`. Any other host, live included, throws
 *     before a request is built. A typo cannot reach the real venue.
 *  2. **Writes are off unless asked for.** `writesEnabled` defaults to false
 *     and every ordering method throws while it is false, so a bug in the
 *     mirror cannot place an order on a desk that was meant to be observing.
 *  3. **Nothing credential-shaped is ever returned in an error.** Keys and
 *     signatures are redacted from every message this module raises.
 *
 * Endpoint choices worth recording, all verified against the demo account on
 * 2026-10-01:
 *
 *  - Conditional orders go to `POST /fapi/v1/algoOrder` with
 *    `algoType=CONDITIONAL`. Since 2025-12-09 `POST /fapi/v1/order` rejects
 *    them with `-4120 STOP_ORDER_SWITCH_ALGO`. The trigger field is
 *    `triggerPrice`, NOT `stopPrice`.
 *  - Permission flags (`canTrade`, `feeTier`) exist only on
 *    `GET /fapi/v2/account`; `v3` dropped them and returns balances only.
 *  - The DEMO venue's lot and notional filters differ from live (BTCUSDT
 *    stepSize 0.0001 against 0.001, LINKUSDT minNotional 5 against 20), so
 *    sizing must use filters read from THIS venue at runtime, never the live
 *    table `src/lib/trade-plan/venue.ts` holds for the ticket.
 */

export const DEMO_BASE_URL = 'https://demo-fapi.binance.com';

export class DemoExecutionError extends Error {
  readonly code: number | null;
  readonly status: number;
  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.name = 'DemoExecutionError';
    this.status = status;
    this.code = code;
  }
}

/** Writes were attempted on a client that was not enabled for them. */
export class WritesDisabledError extends Error {
  constructor(action: string) {
    super(`Writes are disabled on this client; refused to ${action}`);
    this.name = 'WritesDisabledError';
  }
}

export interface DemoClientOptions {
  apiKey: string;
  apiSecret: string;
  /** Must be the demo host. Present only so a test can prove the allowlist rejects others. */
  baseUrl?: string;
  /** Every ordering method throws while this is false. */
  writesEnabled?: boolean;
  recvWindow?: number;
  fetchImpl?: typeof fetch;
}

export interface DemoVenueFilter {
  symbol: string;
  status: string;
  stepSize: number;
  minQty: number;
  minNotional: number;
  tickSize: number;
}

export interface DemoPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  unrealizedProfit: number;
}

export interface DemoAlgoOrder {
  algoId: number;
  clientAlgoId: string;
  symbol: string;
  side: string;
  type: string;
  triggerPrice: number;
  quantity: number;
}

export interface DemoUserTrade {
  id: number;
  orderId: number;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: number;
}

type Primitive = string | number | boolean;

export class BinanceDemoClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly recvWindow: number;
  private readonly doFetch: typeof fetch;
  readonly writesEnabled: boolean;

  constructor(options: DemoClientOptions) {
    const baseUrl = options.baseUrl ?? DEMO_BASE_URL;
    if (baseUrl !== DEMO_BASE_URL) {
      // Deliberately an exact string match rather than a hostname parse: a
      // parse invites "close enough" hosts, and there is exactly one correct
      // value.
      throw new Error(
        `Refusing to build a demo client for ${baseUrl}; only ${DEMO_BASE_URL} is allowed`
      );
    }
    if (!options.apiKey || !options.apiSecret) {
      throw new Error('A demo client needs both BINANCE_DEMO_API_KEY and BINANCE_DEMO_API_SECRET');
    }
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.baseUrl = baseUrl;
    this.writesEnabled = options.writesEnabled ?? false;
    this.recvWindow = options.recvWindow ?? 5000;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /** Builds a client from the environment, or returns why it could not. */
  static fromEnv(options: { writesEnabled?: boolean } = {}): BinanceDemoClient | null {
    const apiKey = process.env.BINANCE_DEMO_API_KEY;
    const apiSecret = process.env.BINANCE_DEMO_API_SECRET;
    if (!apiKey || !apiSecret) return null;
    return new BinanceDemoClient({ apiKey, apiSecret, ...options });
  }

  /** Strips anything credential-shaped out of text bound for a log or an error. */
  redact(text: string): string {
    let out = text;
    for (const secret of [this.apiKey, this.apiSecret]) {
      if (secret.length > 4) out = out.split(secret).join('[redacted]');
    }
    return out.replace(/signature=[0-9a-f]+/gi, 'signature=[redacted]');
  }

  private sign(params: Record<string, Primitive>): URLSearchParams {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
    query.set('timestamp', String(Date.now()));
    query.set('recvWindow', String(this.recvWindow));
    query.set('signature', createHmac('sha256', this.apiSecret).update(query.toString()).digest('hex'));
    return query;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, Primitive> = {},
    { signed = true }: { signed?: boolean } = {}
  ): Promise<T> {
    const query = signed ? this.sign(params) : new URLSearchParams(params as Record<string, string>);
    const url = `${this.baseUrl}${path}${query.size > 0 ? `?${query}` : ''}`;
    const res = await this.doFetch(url, {
      method,
      headers: signed ? { 'X-MBX-APIKEY': this.apiKey } : {},
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    if (!res.ok) {
      const code =
        body && typeof body === 'object' && 'code' in body ? Number((body as { code: unknown }).code) : null;
      const msg =
        body && typeof body === 'object' && 'msg' in body
          ? String((body as { msg: unknown }).msg)
          : typeof body === 'string'
            ? body.slice(0, 200)
            : `HTTP ${res.status}`;
      throw new DemoExecutionError(this.redact(`${method} ${path} failed: ${msg}`), res.status, code);
    }

    return body as T;
  }

  // --- reads ---

  /** The DEMO venue's own filters, which are not the live ones. */
  async venueFilters(): Promise<Map<string, DemoVenueFilter>> {
    const info = await this.request<{
      symbols: Array<{
        symbol: string;
        status: string;
        contractType: string;
        filters: Array<Record<string, string>>;
      }>;
    }>('GET', '/fapi/v1/exchangeInfo', {}, { signed: false });

    const out = new Map<string, DemoVenueFilter>();
    for (const s of info.symbols) {
      if (s.contractType !== 'PERPETUAL') continue;
      const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
      const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
      const price = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      if (!lot || !notional || !price) continue;
      out.set(s.symbol, {
        symbol: s.symbol,
        status: s.status,
        stepSize: Number(lot.stepSize),
        minQty: Number(lot.minQty),
        minNotional: Number(notional.notional),
        tickSize: Number(price.tickSize),
      });
    }
    return out;
  }

  /** Permission flags, which live on v2 only. */
  async permissions(): Promise<{ canTrade: boolean; feeTier: number; multiAssetsMargin: boolean }> {
    const body = await this.request<{ canTrade: boolean; feeTier: number; multiAssetsMargin: boolean }>(
      'GET',
      '/fapi/v2/account'
    );
    return {
      canTrade: body.canTrade === true,
      feeTier: Number(body.feeTier),
      multiAssetsMargin: body.multiAssetsMargin === true,
    };
  }

  async usdtBalance(): Promise<number> {
    const rows = await this.request<Array<{ asset: string; availableBalance: string; balance: string }>>(
      'GET',
      '/fapi/v3/balance'
    );
    const usdt = rows.find((r) => r.asset === 'USDT');
    return usdt ? Number(usdt.balance) : 0;
  }

  /** True when the account is in one-way mode, which `reduceOnly` requires. */
  async isOneWayMode(): Promise<boolean> {
    const body = await this.request<{ dualSidePosition: boolean }>('GET', '/fapi/v1/positionSide/dual');
    return body.dualSidePosition === false;
  }

  /** Open positions only; v3 already filters out the flat rows. */
  async openPositions(): Promise<DemoPosition[]> {
    const rows = await this.request<
      Array<{ symbol: string; positionAmt: string; entryPrice: string; unRealizedProfit?: string; unrealizedProfit?: string }>
    >('GET', '/fapi/v3/positionRisk');
    return rows
      .map((r) => ({
        symbol: r.symbol,
        positionAmt: Number(r.positionAmt),
        entryPrice: Number(r.entryPrice),
        unrealizedProfit: Number(r.unRealizedProfit ?? r.unrealizedProfit ?? 0),
      }))
      .filter((p) => p.positionAmt !== 0);
  }

  async openAlgoOrders(symbol?: string): Promise<DemoAlgoOrder[]> {
    const body = await this.request<unknown>('GET', '/fapi/v1/openAlgoOrders', symbol ? { symbol } : {});
    const rows = Array.isArray(body)
      ? body
      : ((body as { orders?: unknown[] } | null)?.orders ?? []);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      algoId: Number(r.algoId),
      clientAlgoId: String(r.clientAlgoId ?? ''),
      symbol: String(r.symbol),
      side: String(r.side),
      type: String(r.type),
      triggerPrice: Number(r.triggerPrice ?? 0),
      quantity: Number(r.quantity ?? r.origQty ?? 0),
    }));
  }

  /** Real fills, which is how the mirror learns what it actually paid. */
  async userTrades(symbol: string, startTime?: number): Promise<DemoUserTrade[]> {
    const rows = await this.request<Array<Record<string, string>>>('GET', '/fapi/v1/userTrades', {
      symbol,
      ...(startTime ? { startTime } : {}),
      limit: 100,
    });
    return rows.map((r) => ({
      id: Number(r.id),
      orderId: Number(r.orderId),
      symbol: r.symbol,
      side: r.side,
      price: Number(r.price),
      qty: Number(r.qty),
      realizedPnl: Number(r.realizedPnl),
      commission: Number(r.commission),
      commissionAsset: r.commissionAsset,
      time: Number(r.time),
    }));
  }

  // --- writes, all refused while writesEnabled is false ---

  private assertWrites(action: string): void {
    if (!this.writesEnabled) throw new WritesDisabledError(action);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.assertWrites(`set leverage on ${symbol}`);
    await this.request('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  /** A market order. `reduceOnly` makes it an exit that can never open a position. */
  async marketOrder(args: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    reduceOnly?: boolean;
    newClientOrderId?: string;
  }): Promise<{ orderId: number; status: string }> {
    this.assertWrites(`place a market order on ${args.symbol}`);
    return this.request('POST', '/fapi/v1/order', {
      symbol: args.symbol,
      side: args.side,
      type: 'MARKET',
      quantity: args.quantity,
      ...(args.reduceOnly ? { reduceOnly: 'true' } : {}),
      ...(args.newClientOrderId ? { newClientOrderId: args.newClientOrderId } : {}),
    });
  }

  /**
   * A conditional (algo) order: the only way to place a stop or target since
   * 2025-12-09. `reduceOnly` is used rather than `closePosition` so a partial
   * size is possible, and the two cannot be combined anyway.
   */
  async conditionalOrder(args: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: number;
    quantity: number;
    clientAlgoId?: string;
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  }): Promise<{ algoId: number; clientAlgoId?: string }> {
    this.assertWrites(`place a ${args.type} on ${args.symbol}`);
    return this.request('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol: args.symbol,
      side: args.side,
      type: args.type,
      triggerPrice: args.triggerPrice,
      quantity: args.quantity,
      reduceOnly: 'true',
      workingType: args.workingType ?? 'CONTRACT_PRICE',
      ...(args.clientAlgoId ? { clientAlgoId: args.clientAlgoId } : {}),
    });
  }

  async cancelAlgoOrder(symbol: string, algoId: number): Promise<void> {
    this.assertWrites(`cancel algo order ${algoId} on ${symbol}`);
    await this.request('DELETE', '/fapi/v1/algoOrder', { symbol, algoId });
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    this.assertWrites(`cancel all open orders on ${symbol}`);
    await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  }
}

/** Decimal places of an increment, so a rounded value carries no binary noise. */
function decimalsOf(increment: number): number {
  const text = increment.toString();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Rounds a quantity DOWN to the venue's step: never larger than intended. */
export function roundToStep(quantity: number, stepSize: number): number {
  if (!(quantity > 0) || !(stepSize > 0)) return 0;
  const steps = Math.floor(quantity / stepSize + 1e-9);
  return Number((steps * stepSize).toFixed(decimalsOf(stepSize)));
}

/** Rounds a price to the venue's tick. */
export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  return Number((Math.round(price / tickSize) * tickSize).toFixed(decimalsOf(tickSize)));
}
