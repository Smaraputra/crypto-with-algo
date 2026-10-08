import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  CostCheckError,
  CostCheckErrorCode,
  CostCheckMarketResponse,
  CostCheckRegimeResponse,
  CostCheckSymbolsResponse,
} from '@/types/cost-check';

/**
 * A failed Cost Check request with the API's error code kept. fetchJson keeps
 * only a message, and the page needs the code to tell "the exchange is
 * unreachable" from "that symbol does not exist".
 */
export class CostCheckRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: CostCheckErrorCode | 'unauthorized' | 'rate_limited' | 'unknown',
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'CostCheckRequestError';
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as Partial<CostCheckError> & { error?: string };
  const code =
    res.status === 401
      ? 'unauthorized'
      : res.status === 429
        ? 'rate_limited'
        : ((body.error as CostCheckErrorCode | undefined) ?? 'unknown');
  throw new CostCheckRequestError(body.message ?? body.error ?? `Request failed (${res.status})`, res.status, code, body.retryAfterSeconds);
}

export function useCostCheckSymbols() {
  return useQuery<CostCheckSymbolsResponse, CostCheckRequestError>({
    queryKey: ['costCheckSymbols'],
    queryFn: () => getJson('/api/cost-check/symbols'),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

export function useCostCheckMarket(symbol: string, holdMinutes: number, notional: number) {
  return useQuery<CostCheckMarketResponse, CostCheckRequestError>({
    queryKey: ['costCheckMarket', symbol, holdMinutes, notional],
    queryFn: () => {
      const params = new URLSearchParams({
        symbol,
        holdMinutes: String(holdMinutes),
        notional: String(notional),
      });
      return getJson(`/api/cost-check?${params}`);
    },
    enabled: symbol.length > 0 && holdMinutes >= 1 && notional > 0,
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
    // A missing symbol or a bad request will not fix itself; one retry for a venue hiccup.
    retry: (count, error) => error.status >= 500 && count < 1,
  });
}

/** BTCUSDT's volatility regime. It changes once a UTC day, so it is fetched once a page view and kept. */
export function useCostCheckRegime() {
  return useQuery<CostCheckRegimeResponse, CostCheckRequestError>({
    queryKey: ['costCheckRegime'],
    queryFn: () => getJson('/api/cost-check/regime'),
    staleTime: 30 * 60 * 1000,
    retry: (count, error) => error.status >= 500 && count < 1,
  });
}
