import { NextResponse } from 'next/server';

import {
  BinanceHttpError,
  DEFAULT_FUNDING_INTERVAL_HOURS,
  fetchDepth,
  fetchFundingInfo,
  fetchPerpExchangeInfo,
  fetchPerpKlines,
  fetchPremiumIndex,
  type PerpDepth,
  type PerpExchangeSymbol,
  type PerpKline,
  type PremiumIndex,
} from '@/lib/binance-futures';
import { closedBars, depthSlippageBps, effectiveMinNotional } from '@/lib/costs/market-facts';
import { holdMoveStats, type Measurement } from '@/lib/costs/move';
import { cachedFetch, redis } from '@/lib/redis';
import { parseVenueFilters } from '@/lib/venue-filters';
import type { CostCheckError, CostCheckMarketResponse } from '@/types/cost-check';

export const EXCHANGE_INFO_KEY = 'cost-check:exinfo';
export const FUNDING_INFO_KEY = 'cost-check:fundinginfo';
export const EXCHANGE_INFO_TTL = 3600;
export const KLINES_TTL = 300;
export const PREMIUM_TTL = 60;
export const DEPTH_TTL = 15;
export const LAST_GOOD_TTL = 24 * 3600;

/** Flat one-way slippage assumed when the order book cannot be read. */
export const FALLBACK_SLIPPAGE_BPS = 5;

const KEPT_FILTERS = new Set(['LOT_SIZE', 'MIN_NOTIONAL', 'PRICE_FILTER', 'MARKET_LOT_SIZE']);

/** exchangeInfo trimmed to the fields the cost check reads, so the cached copy stays small. */
export function getExchangeSymbols(): Promise<PerpExchangeSymbol[]> {
  return cachedFetch(
    EXCHANGE_INFO_KEY,
    async () =>
      (await fetchPerpExchangeInfo()).map((s) => ({
        symbol: s.symbol,
        status: s.status,
        contractType: s.contractType,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        underlyingType: s.underlyingType,
        onboardDate: s.onboardDate,
        filters: (s.filters ?? []).filter((f) => KEPT_FILTERS.has(f.filterType)),
      })),
    EXCHANGE_INFO_TTL
  );
}

export function lastGoodKey(symbol: string, measurement: Pick<Measurement, 'interval' | 'holdBars'>): string {
  return `cost-check:last-good:${symbol}:${measurement.interval}:${measurement.holdBars}`;
}

/** Builds the market response from live (or cached) venue data. Throws on venue failure. */
export async function buildMarketFacts(
  symbol: string,
  measurement: Measurement,
  notional: number,
  exchangeSymbols: readonly PerpExchangeSymbol[],
  now: number
): Promise<CostCheckMarketResponse> {
  const [klines, premium, fundingInfo, depth] = await Promise.all([
    cachedFetch<PerpKline[]>(
      `cost-check:klines:${symbol}:${measurement.interval}`,
      () => fetchPerpKlines(symbol, measurement.interval, 1000),
      KLINES_TTL
    ),
    cachedFetch<PremiumIndex>(`cost-check:premium:${symbol}`, () => fetchPremiumIndex(symbol), PREMIUM_TTL),
    cachedFetch<Record<string, number>>(FUNDING_INFO_KEY, fetchFundingInfo, EXCHANGE_INFO_TTL),
    cachedFetch<PerpDepth>(`cost-check:depth:${symbol}`, () => fetchDepth(symbol, 20), DEPTH_TTL).catch(
      () => null
    ),
  ]);

  const filter = parseVenueFilters(exchangeSymbols.filter((s) => s.symbol === symbol)).get(symbol);
  if (!filter) throw new Error(`No venue filters for ${symbol}`);
  const listing = exchangeSymbols.find((s) => s.symbol === symbol);

  const closes = closedBars(klines, now).map((k) => k.close);

  let slippage: CostCheckMarketResponse['slippage'] = {
    bps: FALLBACK_SLIPPAGE_BPS,
    source: 'fallback',
    halfSpreadBps: null,
    exceedsTopOfBook: false,
  };
  if (depth) {
    try {
      const s = depthSlippageBps(depth, notional);
      slippage = {
        bps: s.bps,
        source: 'depth',
        halfSpreadBps: s.halfSpreadBps,
        exceedsTopOfBook: s.exceedsTopOfBook,
      };
    } catch {
      // Unusable book: keep the flat fallback.
    }
  }

  return {
    symbol,
    asOf: now,
    stale: false,
    markPrice: premium.markPrice,
    funding: {
      rate: premium.lastFundingRate,
      intervalHours: fundingInfo[symbol] ?? DEFAULT_FUNDING_INTERVAL_HOURS,
      nextFundingTime: premium.nextFundingTime,
    },
    venue: {
      minNotional: filter.minNotional,
      minQty: filter.minQty,
      stepSize: filter.stepSize,
      tickSize: filter.tickSize,
      effectiveMinNotional: effectiveMinNotional(filter, premium.markPrice),
    },
    measurement: {
      interval: measurement.interval,
      holdBars: measurement.holdBars,
      measuredHoldMs: measurement.measuredHoldMs,
      barsUsed: closes.length,
    },
    move: holdMoveStats(closes, measurement.holdBars),
    slippage,
    onboardDate: listing?.onboardDate ?? 0,
  };
}

export async function readLastGood(key: string): Promise<CostCheckMarketResponse | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as CostCheckMarketResponse) : null;
  } catch {
    return null;
  }
}

export async function writeLastGood(key: string, body: CostCheckMarketResponse): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(body), { ex: LAST_GOOD_TTL });
  } catch {
    // Fail open: the live response is still returned.
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

/** Maps any failure while talking to the venue to a sanitised 503. Never echoes upstream text. */
export function venueErrorResponse(error: unknown): NextResponse<CostCheckError> {
  if (error instanceof BinanceHttpError && (error.status === 418 || error.status === 429)) {
    const retryAfterSeconds = parseRetryAfter(error.retryAfter);
    const body: CostCheckError = {
      error: 'venue_rate_limited',
      message: 'The exchange is rate limiting requests. Try again shortly.',
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
    return NextResponse.json(body, {
      status: 503,
      headers: retryAfterSeconds !== undefined ? { 'Retry-After': String(retryAfterSeconds) } : undefined,
    });
  }
  return NextResponse.json(
    { error: 'venue_unreachable', message: 'The exchange could not be reached. Try again shortly.' },
    { status: 503 }
  );
}
