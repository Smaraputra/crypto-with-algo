import type { ExchangeInfoSymbolFilters } from '@/lib/venue-filters';
import type {
  FundingRate,
  GlobalLongShortRatio,
  LongShortRatio,
  OpenInterest,
  OpenInterestHist,
} from '@/types/futures';

const DEFAULT_FUTURES_URL = 'https://fapi.binance.com';

function getBaseUrl(): string {
  return process.env.BINANCE_FUTURES_API_URL || DEFAULT_FUTURES_URL;
}

export async function fetchFundingRate(
  symbol: string,
  limit = 1,
  startTime?: number,
  endTime?: number
): Promise<FundingRate[]> {
  const params = new URLSearchParams({ symbol, limit: String(limit) });
  if (startTime !== undefined) params.set('startTime', String(startTime));
  if (endTime !== undefined) params.set('endTime', String(endTime));
  const res = await fetch(`${getBaseUrl()}/fapi/v1/fundingRate?${params}`);

  if (!res.ok) {
    throw new Error(`Failed to fetch funding rate for ${symbol}: HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.map(
    (d: { symbol: string; fundingRate: string; fundingTime: number; markPrice: string }) => ({
      symbol: d.symbol,
      fundingRate: parseFloat(d.fundingRate),
      fundingTime: d.fundingTime,
      markPrice: parseFloat(d.markPrice),
    })
  );
}

export async function fetchOpenInterest(symbol: string): Promise<OpenInterest> {
  const params = new URLSearchParams({ symbol });
  const res = await fetch(`${getBaseUrl()}/fapi/v1/openInterest?${params}`);

  if (!res.ok) {
    throw new Error(`Failed to fetch open interest for ${symbol}: HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    symbol: data.symbol,
    openInterest: parseFloat(data.openInterest),
    time: data.time,
  };
}

export async function fetchOpenInterestHistory(
  symbol: string,
  period = '5m',
  limit = 30
): Promise<OpenInterestHist[]> {
  const params = new URLSearchParams({ symbol, period, limit: String(limit) });
  const res = await fetch(`${getBaseUrl()}/futures/data/openInterestHist?${params}`);

  if (!res.ok) {
    throw new Error(
      `Failed to fetch OI history for ${symbol}: HTTP ${res.status}`
    );
  }

  const data = await res.json();
  return data.map(
    (d: {
      symbol: string;
      sumOpenInterest: string;
      sumOpenInterestValue: string;
      timestamp: number;
    }) => ({
      symbol: d.symbol,
      sumOpenInterest: parseFloat(d.sumOpenInterest),
      sumOpenInterestValue: parseFloat(d.sumOpenInterestValue),
      timestamp: d.timestamp,
    })
  );
}

export async function fetchLongShortRatio(
  symbol: string,
  period = '1h',
  limit = 30
): Promise<LongShortRatio[]> {
  const params = new URLSearchParams({ symbol, period, limit: String(limit) });
  const res = await fetch(
    `${getBaseUrl()}/futures/data/topLongShortPositionRatio?${params}`
  );

  if (!res.ok) {
    throw new Error(
      `Failed to fetch long/short ratio for ${symbol}: HTTP ${res.status}`
    );
  }

  const data = await res.json();
  return data.map(
    (d: {
      symbol: string;
      longShortRatio: string;
      longAccount: string;
      shortAccount: string;
      timestamp: number;
    }) => ({
      symbol: d.symbol,
      longShortRatio: parseFloat(d.longShortRatio),
      longAccount: parseFloat(d.longAccount),
      shortAccount: parseFloat(d.shortAccount),
      timestamp: d.timestamp,
    })
  );
}

export async function fetchGlobalLongShortRatio(
  symbol: string,
  period = '1h',
  limit = 30
): Promise<GlobalLongShortRatio[]> {
  const params = new URLSearchParams({ symbol, period, limit: String(limit) });
  const res = await fetch(
    `${getBaseUrl()}/futures/data/globalLongShortAccountRatio?${params}`
  );

  if (!res.ok) {
    throw new Error(
      `Failed to fetch global L/S ratio for ${symbol}: HTTP ${res.status}`
    );
  }

  const data = await res.json();
  return data.map(
    (d: {
      symbol: string;
      longShortRatio: string;
      longAccount: string;
      shortAccount: string;
      timestamp: number;
    }) => ({
      symbol: d.symbol,
      longShortRatio: parseFloat(d.longShortRatio),
      longAccount: parseFloat(d.longAccount),
      shortAccount: parseFloat(d.shortAccount),
      timestamp: d.timestamp,
    })
  );
}

// --- Cost check market facts ---

const REQUEST_TIMEOUT_MS = 10_000;

/** A non-2xx answer from the futures venue. Carries no upstream body. */
export class BinanceHttpError extends Error {
  readonly status: number;
  /** The `Retry-After` header value (seconds as sent), when the venue gave one. */
  readonly retryAfter: string | null;

  constructor(path: string, status: number, retryAfter: string | null = null) {
    super(`Binance futures ${path} failed: HTTP ${status}`);
    this.name = 'BinanceHttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const query = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${getBaseUrl()}${path}${query}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new BinanceHttpError(path, res.status, res.headers?.get?.('Retry-After') ?? null);
  }
  return (await res.json()) as T;
}

/** An exchangeInfo symbol, with the fields the cost check reads. */
export interface PerpExchangeSymbol extends ExchangeInfoSymbolFilters {
  baseAsset: string;
  quoteAsset: string;
  /** `COIN` for crypto, other values for TradFi-style perpetuals. */
  underlyingType?: string;
  /** Listing time, epoch ms. */
  onboardDate?: number;
}

/** `/fapi/v1/exchangeInfo` (weight 1): every futures symbol. */
export async function fetchPerpExchangeInfo(): Promise<PerpExchangeSymbol[]> {
  const data = await getJson<{ symbols: PerpExchangeSymbol[] }>('/fapi/v1/exchangeInfo');
  return data.symbols;
}

export interface PerpKline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote-asset (USDT) volume. */
  quoteVolume: number;
}

/** `/fapi/v1/klines`. The in-progress bar, when present, is last. */
export async function fetchPerpKlines(
  symbol: string,
  interval: string,
  limit = 1000
): Promise<PerpKline[]> {
  const rows = await getJson<unknown[][]>('/fapi/v1/klines', {
    symbol,
    interval,
    limit: String(limit),
  });
  return rows.map((r) => ({
    openTime: Number(r[0]),
    open: parseFloat(String(r[1])),
    high: parseFloat(String(r[2])),
    low: parseFloat(String(r[3])),
    close: parseFloat(String(r[4])),
    closeTime: Number(r[6]),
    quoteVolume: parseFloat(String(r[7])),
  }));
}

export interface PremiumIndex {
  markPrice: number;
  lastFundingRate: number;
  nextFundingTime: number;
}

/** `/fapi/v1/premiumIndex?symbol=`: mark price and the funding rate in force. */
export async function fetchPremiumIndex(symbol: string): Promise<PremiumIndex> {
  const d = await getJson<{ markPrice: string; lastFundingRate: string; nextFundingTime: number }>(
    '/fapi/v1/premiumIndex',
    { symbol }
  );
  return {
    markPrice: parseFloat(d.markPrice),
    lastFundingRate: parseFloat(d.lastFundingRate),
    nextFundingTime: Number(d.nextFundingTime),
  };
}

/** Funding settlement interval assumed for a symbol absent from `fundingInfo`. */
export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

/**
 * `/fapi/v1/fundingInfo`: symbol to `fundingIntervalHours`. The endpoint lists
 * ONLY symbols whose funding parameters were adjusted, so a symbol absent from
 * the map settles every 8 hours (`DEFAULT_FUNDING_INTERVAL_HOURS`).
 */
export async function fetchFundingInfo(): Promise<Record<string, number>> {
  const rows = await getJson<Array<{ symbol: string; fundingIntervalHours: number }>>(
    '/fapi/v1/fundingInfo'
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    const hours = Number(r.fundingIntervalHours);
    // A row without a usable interval is left out, so the caller's 8-hour default applies.
    if (Number.isFinite(hours) && hours > 0) out[r.symbol] = hours;
  }
  return out;
}

export interface PerpDepth {
  /** Best (highest) first, [price, quantity in base units]. */
  bids: [number, number][];
  /** Best (lowest) first, [price, quantity in base units]. */
  asks: [number, number][];
}

/** `/fapi/v1/depth`: the top `limit` levels per side. */
export async function fetchDepth(symbol: string, limit = 20): Promise<PerpDepth> {
  const d = await getJson<{ bids: [string, string][]; asks: [string, string][] }>(
    '/fapi/v1/depth',
    { symbol, limit: String(limit) }
  );
  const level = ([p, q]: [string, string]): [number, number] => [parseFloat(p), parseFloat(q)];
  return { bids: d.bids.map(level), asks: d.asks.map(level) };
}
