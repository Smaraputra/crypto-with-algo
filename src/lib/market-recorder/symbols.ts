import { z } from 'zod';

/**
 * Which perpetuals the recorder subscribes to, and the stream URL it opens.
 *
 * The universe is the top N USDT-M perpetuals by 24-hour quote volume among
 * symbols with contractType PERPETUAL, status TRADING, quoteAsset USDT and
 * underlyingType COIN. The last two matter: since 2026 the same exchangeInfo
 * lists TRADIFI_PERPETUAL equity and commodity contracts and USDC-quoted
 * perps, and the 24h ticker still carries delisted (SETTLING) symbols.
 *
 * The REST fetch lives here rather than in `src/lib/binance-futures.ts`
 * because the cost-check branch adds `fetchPerpExchangeInfo` there and the two
 * would collide; once both are on main this can call that instead.
 */

/** Binance's limit per connection. One slot goes to `!forceOrder@arr`. */
export const MAX_STREAMS_PER_CONNECTION = 1024;

/** Since the 2026-04-23 routing change only the `/market` path carries aggTrade and forceOrder. */
export const DEFAULT_FUTURES_WS_BASE = 'wss://fstream.binance.com/market';
export const DEFAULT_FUTURES_REST_BASE = 'https://fapi.binance.com';

export const LIQUIDATION_STREAM = '!forceOrder@arr';

const REST_TIMEOUT_MS = 15_000;

export interface ExchangeSymbol {
  symbol: string;
  contractType?: string;
  status?: string;
  quoteAsset?: string;
  underlyingType?: string;
}

export interface TickerQuoteVolume {
  symbol: string;
  quoteVolume: string;
}

export interface RankedSymbol {
  symbol: string;
  quoteVolume: number;
}

export interface SymbolSelection {
  symbols: RankedSymbol[];
  eligibleCount: number;
  topN: number;
}

export function isEligiblePerp(s: ExchangeSymbol): boolean {
  return (
    s.contractType === 'PERPETUAL' &&
    s.status === 'TRADING' &&
    s.quoteAsset === 'USDT' &&
    s.underlyingType === 'COIN'
  );
}

/**
 * Ranks eligible symbols by 24h quote volume, highest first, ties by symbol.
 * An eligible symbol with no ticker row, or an unreadable volume, is left out:
 * it cannot be ranked, and a listing that young is not top-N anyway.
 */
export function selectTopSymbols(
  exchangeSymbols: readonly ExchangeSymbol[],
  tickers: readonly TickerQuoteVolume[],
  topN: number
): SymbolSelection {
  const eligible = new Set(exchangeSymbols.filter(isEligiblePerp).map((s) => s.symbol));
  const ranked: RankedSymbol[] = [];
  for (const t of tickers) {
    if (!eligible.has(t.symbol)) continue;
    const quoteVolume = Number(t.quoteVolume);
    if (!Number.isFinite(quoteVolume) || quoteVolume < 0) continue;
    ranked.push({ symbol: t.symbol, quoteVolume });
  }
  ranked.sort((a, b) => b.quoteVolume - a.quoteVolume || a.symbol.localeCompare(b.symbol));
  return { symbols: ranked.slice(0, topN), eligibleCount: eligible.size, topN };
}

/** True when the two sets hold the same symbols, in any order. */
export function sameSymbolSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((s) => set.has(s));
}

/**
 * The combined-stream URL, every stream in the query (no runtime SUBSCRIBE,
 * so nothing counts against the 10 incoming messages a second limit).
 * Stream names are lowercase; a non-ASCII symbol is percent-encoded by the
 * WebSocket URL parser, which Binance accepts (checked live, 2026-10-08).
 */
export function buildStreamUrl(base: string, symbols: readonly string[]): string {
  const streams = [LIQUIDATION_STREAM, ...symbols.map((s) => `${s.toLowerCase()}@aggTrade`)];
  if (streams.length > MAX_STREAMS_PER_CONNECTION) {
    throw new Error(`${streams.length} streams exceed Binance's ${MAX_STREAMS_PER_CONNECTION} per connection`);
  }
  return `${base.replace(/\/+$/, '')}/stream?streams=${streams.join('/')}`;
}

const exchangeInfoSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string(),
      contractType: z.string().optional(),
      status: z.string().optional(),
      quoteAsset: z.string().optional(),
      underlyingType: z.string().optional(),
    })
  ),
});

const tickersSchema = z.array(z.object({ symbol: z.string(), quoteVolume: z.string() }));

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${new URL(url).pathname} failed: HTTP ${res.status}`);
  return res.json();
}

/** `/fapi/v1/exchangeInfo` (weight 1) and `/fapi/v1/ticker/24hr` (weight 40), once a day. */
export async function fetchRecorderUniverse(
  restBase: string,
  topN: number,
  fetchImpl: typeof fetch = fetch
): Promise<SymbolSelection> {
  const base = restBase.replace(/\/+$/, '');
  const [info, tickers] = await Promise.all([
    getJson(fetchImpl, `${base}/fapi/v1/exchangeInfo`),
    getJson(fetchImpl, `${base}/fapi/v1/ticker/24hr`),
  ]);
  const parsedInfo = exchangeInfoSchema.safeParse(info);
  if (!parsedInfo.success) throw new Error(`exchangeInfo: unexpected shape (${parsedInfo.error.issues[0]?.message})`);
  const parsedTickers = tickersSchema.safeParse(tickers);
  if (!parsedTickers.success) throw new Error(`ticker/24hr: unexpected shape (${parsedTickers.error.issues[0]?.message})`);
  return selectTopSymbols(parsedInfo.data.symbols, parsedTickers.data, topN);
}
