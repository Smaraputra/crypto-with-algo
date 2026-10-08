import { NextResponse } from 'next/server';

import {
  BinanceHttpError,
  DEFAULT_FUNDING_INTERVAL_HOURS,
  fetchDepth,
  fetchFundingInfo,
  fetchPerpExchangeInfo,
  fetchPerpKlines,
  fetchPerpKlinesRange,
  fetchPremiumIndex,
  type PerpDepth,
  type PerpExchangeSymbol,
  type PerpKline,
  type PremiumIndex,
} from '@/lib/binance-futures';
import { closedBars, depthSlippageBps, effectiveMinNotional } from '@/lib/costs/market-facts';
import { holdMoveStats, type Measurement } from '@/lib/costs/move';
import { REGIME_SYMBOL, regimeHistoryStart, volatilityRegime } from '@/lib/costs/volatility-regime';
import { cachedFetch, redis } from '@/lib/redis';
import { parseVenueFilters } from '@/lib/venue-filters';
import type { CostCheckError, CostCheckMarketResponse, CostCheckRegimeResponse } from '@/types/cost-check';

export const EXCHANGE_INFO_KEY = 'cost-check:exinfo';
export const FUNDING_INFO_KEY = 'cost-check:fundinginfo';
export const EXCHANGE_INFO_TTL = 3600;
export const KLINES_TTL = 300;
export const PREMIUM_TTL = 60;
export const DEPTH_TTL = 15;
export const LAST_GOOD_TTL = 24 * 3600;

/** Flat one-way slippage assumed when the order book cannot be read. */
export const FALLBACK_SLIPPAGE_BPS = 5;

export const FALLBACK_SLIPPAGE: CostCheckMarketResponse['slippage'] = {
  bps: FALLBACK_SLIPPAGE_BPS,
  source: 'fallback',
  halfSpreadBps: null,
  exceedsTopOfBook: false,
};

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

  let slippage: CostCheckMarketResponse['slippage'] = FALLBACK_SLIPPAGE;
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

/** The regime changes only when a UTC day completes; the cache is keyed by that day. */
export const REGIME_TTL = 6 * 3600;
/** A day that could not be measured (bars missing, as around venue maintenance) is retried soon. */
export const REGIME_NULL_TTL = 300;

const DAY_MS = 86_400_000;

export function regimeKey(now: number): string {
  return `cost-check:regime:${REGIME_SYMBOL}:${Math.floor(now / DAY_MS) * DAY_MS - DAY_MS}`;
}

/**
 * BTCUSDT's volatility regime for the last complete UTC day: 181 days of
 * hourly perp bars (about 4,350, three requests), cached per day. Not
 * `cachedFetch`, because an unmeasurable day must not be cached for the
 * whole TTL. Fails open like it: without Redis every call fetches.
 */
export async function getVolatilityRegime(now: number): Promise<CostCheckRegimeResponse> {
  const key = regimeKey(now);
  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit !== null) return JSON.parse(hit) as CostCheckRegimeResponse;
    } catch {
      // Unreadable cache: fetch.
    }
  }
  const lastHourOpen = Math.floor(now / DAY_MS) * DAY_MS - 3_600_000;
  const bars = await fetchPerpKlinesRange(REGIME_SYMBOL, '1h', regimeHistoryStart(now), lastHourOpen);
  const body: CostCheckRegimeResponse = { symbol: REGIME_SYMBOL, asOf: now, regime: volatilityRegime(bars, now) };
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(body), { ex: body.regime ? REGIME_TTL : REGIME_NULL_TTL });
    } catch {
      // The response is still returned.
    }
  }
  return body;
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

/**
 * The last-good copy is shared by every user who asks for the same symbol and
 * hold, so it keeps only public market facts. Slippage is measured for the
 * requester's own notional, which would reveal another user's order size if
 * a stale copy were served with it; the copy carries the flat fallback instead.
 */
export async function writeLastGood(key: string, body: CostCheckMarketResponse): Promise<void> {
  if (!redis) return;
  try {
    const shared: CostCheckMarketResponse = { ...body, slippage: FALLBACK_SLIPPAGE };
    await redis.set(key, JSON.stringify(shared), { ex: LAST_GOOD_TTL });
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
