/**
 * KEYLESS MULTI-VENUE SNAPSHOT RECORDER.
 *
 * PURPOSE.
 * Lighter and Aster have about one year of history, and the book depth of every small coin only
 * exists as a live snapshot, so only a forward record can price a cross-venue spread honestly.
 * This recorder takes one hourly snapshot per venue of funding, mark and index price, open interest,
 * and top-of-book plus depth at 1,000 USD, for every coin listed on at least two of five venues.
 * It records only. No rule is judged on its data until a lock names it. It is read-only and keyless:
 * no API key, no signing, no account.
 *
 * VENUES, ENDPOINTS AND FIELD MAPS.
 * | Venue | Calls | Mapping |
 * |:--|:--|:--|
 * | binance | GET https://fapi.binance.com/fapi/v1/premiumIndex (all symbols), GET /fapi/v1/openInterest?symbol=S (per coin, base-asset units), GET /fapi/v1/depth?symbol=S&limit=100, GET /fapi/v1/fundingInfo (symbols with a non-8h interval: symbol, fundingIntervalHours; default 8) | markPrice, indexPrice, lastFundingRate, nextFundingTime. oiUsd = openInterest x markPrice. Only symbols ending USDT. |
 * | bybit | GET https://api.bybit.com/v5/market/tickers?category=linear (all), GET /v5/market/orderbook?category=linear&symbol=S&limit=200 | ticker fundingRate, nextFundingTime (string ms), fundingIntervalHour, markPrice, indexPrice, openInterestValue (USD). Only USDT-quoted. Depth result.b bids, result.a asks. |
 * | hyperliquid | POST https://api.hyperliquid.xyz/info with {"type":"metaAndAssetCtxs"} (universe plus ctxs, same order), then {"type":"l2Book","coin":C} per coin | ctx funding (rate per HOUR, so fundingIntervalHours = 1), markPx, oraclePx (index), openInterest (base units, oiUsd = openInterest x markPx). nextFundingTime = the next full hour after ts. Skip entries with isDelisted. Book levels[0] bids and levels[1] asks, rows {px, sz, n}. |
 * | lighter | GET https://mainnet.zklighter.elliot.ai/api/v1/orderBooks (market list), GET /api/v1/orderBookDetails?market_id=M per coin, GET /api/v1/orderBookOrders?market_id=M&limit=250 | Only market_type === 'perp' and status === 'active'. Details: mark_price, index_price, open_interest_usd. Funding rate: the latest row of GET /api/v1/fundings?market_id=M&resolution=1h&start_timestamp=<ts/1000-7200>&end_timestamp=<ts/1000>&count_back=2 (fundings[].rate is a string with 4 decimals, so it is coarse, store it as given), fundingIntervalHours = 1. Book: bids and asks arrays of {price, remaining_base_amount} (strings), NOT aggregated and not guaranteed sorted, so sort bids descending and asks ascending before walking. |
 * | aster | GET https://fapi.asterdex.com/fapi/v1/premiumIndex (all), GET /fapi/v1/openInterest?symbol=S, GET /fapi/v1/depth?symbol=S&limit=100, GET /fapi/v1/exchangeInfo (symbol list) | same fields as binance. fundingIntervalHours = 8 unless a later brief says otherwise. Only USDT symbols with status TRADING. |
 *
 * LIMITS.
 * - Lighter funding rate has 4 decimals, so it is coarse.
 * - Binance and Bybit depth may be too thin for 1,000 USD on small coins.
 * - Lighter book is a raw order list, not aggregated and not guaranteed sorted.
 *
 * RESULT: not run yet.
 *
 * Usage:
 *   npx tsx scripts/research/venue-recorder.ts --out <DIR> [--venues binance,bybit,...] [--coins BTC,ETH] [--dry-run]
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { assetKey } from './universe-source';

export type Venue = 'binance' | 'bybit' | 'hyperliquid' | 'lighter' | 'aster';
export const VENUES: readonly Venue[] = ['binance', 'bybit', 'hyperliquid', 'lighter', 'aster'] as const;

export const BACKOFF_MS = [5_000, 15_000, 45_000];
export const MIN_GAP_MS = 200;
export const TIMEOUT_MS = 10_000;

export interface SnapshotRow {
  ts: number;
  venue: Venue;
  coin: string;
  symbol: string;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  nextFundingTime: number | null;
  mark: number | null;
  index: number | null;
  oiUsd: number | null;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  buySlipBps: number | null;
  sellSlipBps: number | null;
}

export interface ManifestError {
  venue: Venue | string;
  call: string;
  status: number | string;
}

export interface Manifest {
  manifest: true;
  ts: number;
  venues: Venue[];
  coins: string[];
  counts: Record<string, number>;
  errors: ManifestError[];
  durationMs: number;
}

export interface DepthBook {
  bids: [number, number][];
  asks: [number, number][];
}

export interface VenueCoinData {
  venue: Venue;
  coin: string;
  symbol: string;
  fundingRate?: number | null;
  fundingIntervalHours?: number | null;
  nextFundingTime?: number | null;
  mark?: number | null;
  index?: number | null;
  oiUsd?: number | null;
  bids?: [number, number][] | null;
  asks?: [number, number][] | null;
}

export interface BinancePremium {
  symbol: string;
  mark: number | null;
  index: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
}

export interface BybitTicker {
  symbol: string;
  fundingRate: number | null;
  nextFundingTime: number | null;
  fundingIntervalHours: number | null;
  mark: number | null;
  index: number | null;
  oiUsd: number | null;
}

export interface HyperliquidCtx {
  coin: string;
  fundingRate: number | null;
  fundingIntervalHours: number;
  mark: number | null;
  index: number | null;
  oiUsd: number | null;
}

export interface LighterMarket {
  symbol: string;
  marketId: number;
}

export interface LighterDetails {
  mark: number | null;
  index: number | null;
  oiUsd: number | null;
}

export interface LighterFunding {
  fundingRate: number | null;
  fundingIntervalHours: number;
}

export interface AsterPremium {
  symbol: string;
  mark: number | null;
  index: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
}

export interface RecorderCliArgs {
  out: string;
  venues: Venue[];
  coins: string[] | null;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFiniteOrNull(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pure Exported Parsers
// ---------------------------------------------------------------------------

/**
 * Parses Binance premiumIndex response into a map of BinancePremium keyed by symbol.
 * Only symbols ending with USDT are included.
 */
export function parseBinancePremium(json: unknown): Map<string, BinancePremium> {
  const map = new Map<string, BinancePremium>();
  const items: unknown[] = Array.isArray(json) ? json : typeof json === 'object' && json !== null ? [json] : [];

  for (const item of items) {
    const rec = asRecord(item);
    if (!rec || typeof rec.symbol !== 'string') continue;
    const symbol = rec.symbol;
    if (!symbol.endsWith('USDT')) continue;

    map.set(symbol, {
      symbol,
      mark: toFiniteOrNull(rec.markPrice),
      index: toFiniteOrNull(rec.indexPrice),
      fundingRate: toFiniteOrNull(rec.lastFundingRate),
      nextFundingTime: toFiniteOrNull(rec.nextFundingTime),
    });
  }
  return map;
}

/**
 * Parses Binance fundingInfo response into a map of fundingIntervalHours keyed by symbol.
 */
export function parseBinanceFundingInfo(json: unknown): Map<string, number> {
  const map = new Map<string, number>();
  const items: unknown[] = Array.isArray(json) ? json : typeof json === 'object' && json !== null ? [json] : [];

  for (const item of items) {
    const rec = asRecord(item);
    if (!rec || typeof rec.symbol !== 'string') continue;
    const hours = toFiniteOrNull(rec.fundingIntervalHours);
    if (hours !== null) {
      map.set(rec.symbol, hours);
    }
  }
  return map;
}

/**
 * Parses Bybit tickers response into a map of BybitTicker keyed by symbol.
 * Only USDT-quoted symbols are included.
 */
export function parseBybitTickers(json: unknown): Map<string, BybitTicker> {
  const map = new Map<string, BybitTicker>();
  const rec = asRecord(json);
  let list: unknown[] = [];

  if (rec) {
    const result = asRecord(rec.result);
    if (result && Array.isArray(result.list)) {
      list = result.list;
    } else if (Array.isArray(rec.list)) {
      list = rec.list;
    }
  } else if (Array.isArray(json)) {
    list = json;
  }

  for (const item of list) {
    const r = asRecord(item);
    if (!r || typeof r.symbol !== 'string') continue;
    const symbol = r.symbol;
    if (!symbol.endsWith('USDT')) continue;

    map.set(symbol, {
      symbol,
      fundingRate: toFiniteOrNull(r.fundingRate),
      nextFundingTime: toFiniteOrNull(r.nextFundingTime),
      fundingIntervalHours: toFiniteOrNull(r.fundingIntervalHour),
      mark: toFiniteOrNull(r.markPrice),
      index: toFiniteOrNull(r.indexPrice),
      oiUsd: toFiniteOrNull(r.openInterestValue),
    });
  }
  return map;
}

/**
 * Parses Hyperliquid metaAndAssetCtxs response into a map of HyperliquidCtx keyed by coin name.
 * Universe entries with isDelisted === true are skipped.
 */
export function parseHyperliquidCtxs(json: unknown): Map<string, HyperliquidCtx> {
  const map = new Map<string, HyperliquidCtx>();
  if (!Array.isArray(json) || json.length < 2) return map;

  const meta = asRecord(json[0]);
  const universe = meta && Array.isArray(meta.universe) ? meta.universe : [];
  const ctxs = Array.isArray(json[1]) ? json[1] : [];

  const count = Math.min(universe.length, ctxs.length);
  for (let i = 0; i < count; i++) {
    const u = asRecord(universe[i]);
    const c = asRecord(ctxs[i]);
    if (!u || !c || typeof u.name !== 'string') continue;
    if (u.isDelisted === true) continue;

    const coin = u.name;
    const fundingRate = toFiniteOrNull(c.funding);
    const mark = toFiniteOrNull(c.markPx);
    const index = toFiniteOrNull(c.oraclePx);
    const openInterest = toFiniteOrNull(c.openInterest);
    const oiUsd = openInterest !== null && mark !== null ? openInterest * mark : null;

    map.set(coin, {
      coin,
      fundingRate,
      fundingIntervalHours: 1,
      mark,
      index,
      oiUsd,
    });
  }
  return map;
}

/**
 * Parses Hyperliquid l2Book response into bids and asks level arrays.
 */
export function parseHyperliquidBook(json: unknown): DepthBook {
  const rec = asRecord(json);
  if (!rec || !Array.isArray(rec.levels) || rec.levels.length < 2) {
    return { bids: [], asks: [] };
  }

  const rawBids = Array.isArray(rec.levels[0]) ? rec.levels[0] : [];
  const rawAsks = Array.isArray(rec.levels[1]) ? rec.levels[1] : [];

  const parseLevels = (raw: unknown[]): [number, number][] => {
    const levels: [number, number][] = [];
    for (const item of raw) {
      const r = asRecord(item);
      if (!r) continue;
      const px = toFiniteOrNull(r.px);
      const sz = toFiniteOrNull(r.sz);
      if (px !== null && sz !== null && px > 0 && sz > 0) {
        levels.push([px, sz]);
      }
    }
    return levels;
  };

  const bids = parseLevels(rawBids).sort((a, b) => b[0] - a[0]);
  const asks = parseLevels(rawAsks).sort((a, b) => a[0] - b[0]);
  return { bids, asks };
}

/**
 * Parses Lighter orderBooks market list, keeping only perp markets with status 'active'.
 */
export function parseLighterMarkets(json: unknown): LighterMarket[] {
  const rec = asRecord(json);
  const list = rec && Array.isArray(rec.order_books) ? rec.order_books : Array.isArray(json) ? json : [];
  const markets: LighterMarket[] = [];

  for (const item of list) {
    const r = asRecord(item);
    if (!r) continue;
    if (r.market_type === 'perp' && r.status === 'active' && typeof r.symbol === 'string') {
      const marketId = toFiniteOrNull(r.market_id);
      if (marketId !== null) {
        markets.push({ symbol: r.symbol, marketId });
      }
    }
  }
  return markets;
}

/**
 * Parses Lighter orderBookDetails response.
 */
export function parseLighterDetails(json: unknown): LighterDetails {
  const rec = asRecord(json);
  let entry: Record<string, unknown> | null = null;

  if (rec && Array.isArray(rec.order_book_details) && rec.order_book_details.length > 0) {
    entry = asRecord(rec.order_book_details[0]);
  } else if (rec) {
    entry = rec;
  }

  if (!entry) {
    return { mark: null, index: null, oiUsd: null };
  }

  return {
    mark: toFiniteOrNull(entry.mark_price),
    index: toFiniteOrNull(entry.index_price),
    oiUsd: toFiniteOrNull(entry.open_interest_usd),
  };
}

/**
 * Parses Lighter fundings response and selects the latest row.
 */
export function parseLighterFunding(json: unknown): LighterFunding {
  const rec = asRecord(json);
  const fundings = rec && Array.isArray(rec.fundings) ? rec.fundings : Array.isArray(json) ? json : [];

  if (fundings.length === 0) {
    return { fundingRate: null, fundingIntervalHours: 1 };
  }

  let latestRow: Record<string, unknown> | null = null;
  let maxTimestamp = -Infinity;

  for (const item of fundings) {
    const r = asRecord(item);
    if (!r) continue;
    const ts = toFiniteOrNull(r.timestamp) ?? 0;
    if (ts >= maxTimestamp) {
      maxTimestamp = ts;
      latestRow = r;
    }
  }

  // The API `rate` is a PERCENT per hour ("0.0012" is 0.0012% = 1.2e-5, checked against the cross-venue
  // funding-rates endpoint on 2026-11-11). `direction` names the paying side: "short" means shorts pay,
  // which is a negative rate on the convention where a positive rate means longs pay.
  const pct = latestRow ? toFiniteOrNull(latestRow.rate) : null;
  const fundingRate =
    pct === null ? null : (pct / 100) * (latestRow !== null && latestRow.direction === 'short' ? -1 : 1);
  return { fundingRate, fundingIntervalHours: 1 };
}

/**
 * Parses Lighter raw orderBookOrders response and sorts bids descending and asks ascending.
 */
export function parseLighterOrders(json: unknown): DepthBook {
  const rec = asRecord(json);
  if (!rec) return { bids: [], asks: [] };

  const rawBids = Array.isArray(rec.bids) ? rec.bids : [];
  const rawAsks = Array.isArray(rec.asks) ? rec.asks : [];

  const parseOrders = (raw: unknown[]): [number, number][] => {
    const list: [number, number][] = [];
    for (const item of raw) {
      const r = asRecord(item);
      if (!r) continue;
      const price = toFiniteOrNull(r.price);
      const size = toFiniteOrNull(r.remaining_base_amount);
      if (price !== null && size !== null && price > 0 && size > 0) {
        list.push([price, size]);
      }
    }
    return list;
  };

  const bids = parseOrders(rawBids).sort((a, b) => b[0] - a[0]);
  const asks = parseOrders(rawAsks).sort((a, b) => a[0] - b[0]);
  return { bids, asks };
}

/**
 * Parses Aster premiumIndex response.
 */
export function parseAsterPremium(json: unknown): Map<string, AsterPremium> {
  const map = new Map<string, AsterPremium>();
  const items: unknown[] = Array.isArray(json) ? json : typeof json === 'object' && json !== null ? [json] : [];

  for (const item of items) {
    const rec = asRecord(item);
    if (!rec || typeof rec.symbol !== 'string') continue;
    const symbol = rec.symbol;
    if (!symbol.endsWith('USDT')) continue;

    map.set(symbol, {
      symbol,
      mark: toFiniteOrNull(rec.markPrice),
      index: toFiniteOrNull(rec.indexPrice),
      fundingRate: toFiniteOrNull(rec.lastFundingRate),
      nextFundingTime: toFiniteOrNull(rec.nextFundingTime),
    });
  }
  return map;
}

/**
 * Parses Aster exchangeInfo, returning symbols with status 'TRADING' and quoteAsset 'USDT'.
 */
export function parseAsterSymbols(json: unknown): string[] {
  const rec = asRecord(json);
  const symbols = rec && Array.isArray(rec.symbols) ? rec.symbols : Array.isArray(json) ? json : [];
  const out: string[] = [];

  for (const item of symbols) {
    const r = asRecord(item);
    if (!r || typeof r.symbol !== 'string') continue;
    const status = String(r.status ?? '');
    const quoteAsset = String(r.quoteAsset ?? '');
    if (status === 'TRADING' && (quoteAsset === 'USDT' || r.symbol.endsWith('USDT'))) {
      out.push(r.symbol);
    }
  }
  return out;
}

/**
 * Parses generic depth rows for Binance, Aster, and Bybit order books.
 */
export function parseDepth(json: unknown): DepthBook {
  const rec = asRecord(json);
  if (!rec) return { bids: [], asks: [] };

  let rawBids: unknown[] = [];
  let rawAsks: unknown[] = [];

  if (Array.isArray(rec.bids) && Array.isArray(rec.asks)) {
    rawBids = rec.bids;
    rawAsks = rec.asks;
  } else {
    const result = asRecord(rec.result);
    if (result && Array.isArray(result.b) && Array.isArray(result.a)) {
      rawBids = result.b;
      rawAsks = result.a;
    } else if (Array.isArray(rec.b) && Array.isArray(rec.a)) {
      rawBids = rec.b;
      rawAsks = rec.a;
    }
  }

  const parsePairs = (raw: unknown[]): [number, number][] => {
    const out: [number, number][] = [];
    for (const item of raw) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const px = toFiniteOrNull(item[0]);
      const sz = toFiniteOrNull(item[1]);
      if (px !== null && sz !== null && px > 0 && sz > 0) {
        out.push([px, sz]);
      }
    }
    return out;
  };

  const bids = parsePairs(rawBids).sort((a, b) => b[0] - a[0]);
  const asks = parsePairs(rawAsks).sort((a, b) => a[0] - b[0]);
  return { bids, asks };
}

/**
 * Parses Binance or Aster openInterest response to number of base-asset units.
 */
export function parseOpenInterest(json: unknown): number | null {
  const rec = asRecord(json);
  if (!rec) return null;
  return toFiniteOrNull(rec.openInterest);
}

// ---------------------------------------------------------------------------
// Coin Normalisation and Universe
// ---------------------------------------------------------------------------

/**
 * Normalises a venue symbol to its base coin key.
 * Strips USDT, Hyperliquid leading 'k' before uppercase letter, and multiplier prefixes.
 */
export function coinKey(venue: Venue, symbol: string): string {
  let s = symbol;
  if (venue === 'hyperliquid' && /^k[A-Z]/.test(s)) {
    s = s.slice(1);
  }
  const bare = s.endsWith('USDT') ? s.slice(0, -4) : s;
  return assetKey(bare);
}

/**
 * Returns sorted list of coins listed on at least two venues.
 */
export function recordedCoins(listings: ReadonlyMap<Venue, Set<string>>): string[] {
  const counts = new Map<string, number>();
  for (const coins of listings.values()) {
    for (const coin of coins) {
      counts.set(coin, (counts.get(coin) ?? 0) + 1);
    }
  }
  const recorded: string[] = [];
  for (const [coin, count] of counts) {
    if (count >= 2) recorded.push(coin);
  }
  return recorded.sort();
}

// ---------------------------------------------------------------------------
// Depth Math
// ---------------------------------------------------------------------------

/**
 * Walks levels to compute slippage in basis points for notionalUsd against mid price.
 * Buy: (avg / mid - 1) x 1e4. Sell: (1 - avg / mid) x 1e4.
 * Returns null if book depth is insufficient.
 */
export function slipBps(
  levelsOrBook: [number, number][] | DepthBook,
  side: 'buy' | 'sell',
  notionalUsdOrMid: number = 1000,
  maybeMid?: number
): number | null {
  let targetLevels: [number, number][];
  let mid: number | null = null;
  let notionalUsd = 1000;

  if (Array.isArray(levelsOrBook)) {
    targetLevels = levelsOrBook;
    if (maybeMid !== undefined) {
      notionalUsd = notionalUsdOrMid;
      mid = maybeMid;
    } else {
      notionalUsd = notionalUsdOrMid;
    }
  } else {
    notionalUsd = notionalUsdOrMid;
    const sortedBids = levelsOrBook.bids.slice().sort((a, b) => b[0] - a[0]);
    const sortedAsks = levelsOrBook.asks.slice().sort((a, b) => a[0] - b[0]);
    targetLevels = side === 'buy' ? sortedAsks : sortedBids;
    const bestBid = sortedBids[0]?.[0];
    const bestAsk = sortedAsks[0]?.[0];
    if (bestBid !== undefined && bestAsk !== undefined && bestBid > 0 && bestAsk > 0) {
      mid = (bestBid + bestAsk) / 2;
    }
  }

  if (mid === null || !Number.isFinite(mid) || mid <= 0) return null;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;

  const sorted = targetLevels.slice().sort((a, b) => (side === 'buy' ? a[0] - b[0] : b[0] - a[0]));

  let usdNeeded = notionalUsd;
  let totalBase = 0;
  let totalUsd = 0;

  for (const [price, size] of sorted) {
    if (price <= 0 || size <= 0) continue;
    const levelUsd = price * size;
    const takeUsd = Math.min(usdNeeded, levelUsd);
    const takeBase = takeUsd / price;
    totalUsd += takeUsd;
    totalBase += takeBase;
    usdNeeded -= takeUsd;
    if (usdNeeded <= 1e-9) break;
  }

  if (usdNeeded > 1e-9) {
    return null;
  }

  const avg = totalUsd / totalBase;
  if (side === 'buy') {
    return (avg / mid - 1) * 1e4;
  } else {
    return (1 - avg / mid) * 1e4;
  }
}

// ---------------------------------------------------------------------------
// Row Assembly
// ---------------------------------------------------------------------------

/**
 * Assembles normalised SnapshotRow rows from raw venue data entries.
 */
export function buildRows(
  ts: number,
  venueData:
    | VenueCoinData[]
    | Iterable<VenueCoinData>
    | Map<Venue, Map<string, VenueCoinData> | VenueCoinData[]>
    | Record<string, unknown>
): SnapshotRow[] {
  const entries: VenueCoinData[] = [];

  if (Array.isArray(venueData)) {
    entries.push(...venueData);
  } else if (venueData instanceof Map) {
    for (const val of venueData.values()) {
      if (Array.isArray(val)) {
        entries.push(...val);
      } else if (val instanceof Map) {
        entries.push(...val.values());
      }
    }
  } else if (typeof venueData === 'object' && venueData !== null) {
    if (Symbol.iterator in venueData) {
      entries.push(...(venueData as Iterable<VenueCoinData>));
    } else {
      for (const val of Object.values(venueData)) {
        if (Array.isArray(val)) {
          entries.push(...(val as VenueCoinData[]));
        } else if (typeof val === 'object' && val !== null) {
          entries.push(...(Object.values(val) as VenueCoinData[]));
        }
      }
    }
  }

  const rows: SnapshotRow[] = [];

  for (const entry of entries) {
    const mark = toFiniteOrNull(entry.mark);
    const index = toFiniteOrNull(entry.index);
    const fundingRate = toFiniteOrNull(entry.fundingRate);
    const fundingIntervalHours = toFiniteOrNull(entry.fundingIntervalHours);
    const nextFundingTime = toFiniteOrNull(entry.nextFundingTime);
    const oiUsd = toFiniteOrNull(entry.oiUsd);

    const bids = (entry.bids ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > 0 && p[1] > 0);
    const asks = (entry.asks ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > 0 && p[1] > 0);

    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);

    const bid = bids.length > 0 ? bids[0][0] : null;
    const ask = asks.length > 0 ? asks[0][0] : null;

    let spreadBps: number | null = null;
    let buySlipBps: number | null = null;
    let sellSlipBps: number | null = null;

    if (bid !== null && ask !== null && bid > 0 && ask > 0) {
      const mid = (bid + ask) / 2;
      if (mid > 0) {
        spreadBps = ((ask - bid) / mid) * 1e4;
        buySlipBps = slipBps(asks, 'buy', 1000, mid);
        sellSlipBps = slipBps(bids, 'sell', 1000, mid);
      }
    }

    rows.push({
      ts,
      venue: entry.venue,
      coin: entry.coin,
      symbol: entry.symbol,
      fundingRate,
      fundingIntervalHours,
      nextFundingTime,
      mark,
      index,
      oiUsd,
      bid,
      ask,
      spreadBps,
      buySlipBps,
      sellSlipBps,
    });
  }

  return rows.sort((a, b) => a.coin.localeCompare(b.coin) || a.venue.localeCompare(b.venue));
}

// ---------------------------------------------------------------------------
// File Output
// ---------------------------------------------------------------------------

/**
 * Appends manifest and rows to DIR/venue-snapshots/YYYY-MM-DD.jsonl.
 * Creates the folder with mode 0o700.
 */
export function writeSnapshot(outDir: string, manifest: Manifest, rows: SnapshotRow[]): string {
  const dateStr = new Date(manifest.ts).toISOString().slice(0, 10);
  const snapshotsDir = join(outDir, 'venue-snapshots');
  mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  const filePath = join(snapshotsDir, `${dateStr}.jsonl`);

  const manifestLine = JSON.stringify(manifest);
  const rowLines = rows.map((r) => JSON.stringify(r));
  const content = [manifestLine, ...rowLines].join('\n') + '\n';

  appendFileSync(filePath, content, { flag: 'a' });
  return filePath;
}

// ---------------------------------------------------------------------------
// HTTP Client and Network Orchestration
// ---------------------------------------------------------------------------

export class VenueHttpClient {
  private lastRequestAt = 0;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly minGapMs: number = MIN_GAP_MS
  ) {}

  async requestJson<T = unknown>(
    url: string,
    init?: RequestInit
  ): Promise<{ data: T | null; error: ManifestError | null }> {
    let lastStatus: number | string = 'unknown';

    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      const wait = this.lastRequestAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      let retry = false;
      try {
        const res = await this.fetchFn(url, {
          ...init,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (res.status === 429 || res.status >= 500) {
          lastStatus = res.status;
          retry = true;
        } else if (!res.ok) {
          return {
            data: null,
            error: { venue: '', call: url, status: res.status },
          };
        } else {
          const json = (await res.json()) as T;
          return { data: json, error: null };
        }
      } catch (err: unknown) {
        lastStatus = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network_error';
        retry = true;
      }

      if (retry && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
      }
    }

    return {
      data: null,
      error: { venue: '', call: url, status: lastStatus },
    };
  }
}

interface VenueListing {
  venue: Venue;
  coinToSymbol: Map<string, string>;
  extra?: Map<string, unknown>;
}

async function discoverBinance(client: VenueHttpClient, errors: ManifestError[]): Promise<VenueListing> {
  const coinToSymbol = new Map<string, string>();
  const extra = new Map<string, unknown>();

  const premRes = await client.requestJson('https://fapi.binance.com/fapi/v1/premiumIndex');
  if (premRes.error) {
    errors.push({ ...premRes.error, venue: 'binance' });
  } else {
    const premiums = parseBinancePremium(premRes.data);
    extra.set('premiums', premiums);
    for (const [symbol] of premiums) {
      const coin = coinKey('binance', symbol);
      coinToSymbol.set(coin, symbol);
    }
  }

  const fundRes = await client.requestJson('https://fapi.binance.com/fapi/v1/fundingInfo');
  if (fundRes.error) {
    errors.push({ ...fundRes.error, venue: 'binance' });
  } else {
    const fundingInfo = parseBinanceFundingInfo(fundRes.data);
    extra.set('fundingInfo', fundingInfo);
  }

  return { venue: 'binance', coinToSymbol, extra };
}

async function discoverBybit(client: VenueHttpClient, errors: ManifestError[]): Promise<VenueListing> {
  const coinToSymbol = new Map<string, string>();
  const extra = new Map<string, unknown>();

  const res = await client.requestJson('https://api.bybit.com/v5/market/tickers?category=linear');
  if (res.error) {
    errors.push({ ...res.error, venue: 'bybit' });
  } else {
    const tickers = parseBybitTickers(res.data);
    extra.set('tickers', tickers);
    for (const [symbol] of tickers) {
      const coin = coinKey('bybit', symbol);
      coinToSymbol.set(coin, symbol);
    }
  }

  return { venue: 'bybit', coinToSymbol, extra };
}

async function discoverHyperliquid(client: VenueHttpClient, errors: ManifestError[]): Promise<VenueListing> {
  const coinToSymbol = new Map<string, string>();
  const extra = new Map<string, unknown>();

  const res = await client.requestJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });

  if (res.error) {
    errors.push({ ...res.error, venue: 'hyperliquid' });
  } else {
    const ctxs = parseHyperliquidCtxs(res.data);
    extra.set('ctxs', ctxs);
    for (const [rawCoin] of ctxs) {
      const coin = coinKey('hyperliquid', rawCoin);
      coinToSymbol.set(coin, rawCoin);
    }
  }

  return { venue: 'hyperliquid', coinToSymbol, extra };
}

async function discoverLighter(client: VenueHttpClient, errors: ManifestError[]): Promise<VenueListing> {
  const coinToSymbol = new Map<string, string>();
  const extra = new Map<string, unknown>();

  const res = await client.requestJson('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
  if (res.error) {
    errors.push({ ...res.error, venue: 'lighter' });
  } else {
    const markets = parseLighterMarkets(res.data);
    const marketMap = new Map<string, number>();
    for (const m of markets) {
      const coin = coinKey('lighter', m.symbol);
      coinToSymbol.set(coin, m.symbol);
      marketMap.set(coin, m.marketId);
    }
    extra.set('markets', marketMap);
  }

  return { venue: 'lighter', coinToSymbol, extra };
}

async function discoverAster(client: VenueHttpClient, errors: ManifestError[]): Promise<VenueListing> {
  const coinToSymbol = new Map<string, string>();
  const extra = new Map<string, unknown>();

  const infoRes = await client.requestJson('https://fapi.asterdex.com/fapi/v1/exchangeInfo');
  if (infoRes.error) {
    errors.push({ ...infoRes.error, venue: 'aster' });
  } else {
    const symbols = parseAsterSymbols(infoRes.data);
    for (const s of symbols) {
      const coin = coinKey('aster', s);
      coinToSymbol.set(coin, s);
    }
  }

  const premRes = await client.requestJson('https://fapi.asterdex.com/fapi/v1/premiumIndex');
  if (premRes.error) {
    errors.push({ ...premRes.error, venue: 'aster' });
  } else {
    const premiums = parseAsterPremium(premRes.data);
    extra.set('premiums', premiums);
  }

  return { venue: 'aster', coinToSymbol, extra };
}

async function fetchBinanceCoin(
  coin: string,
  symbol: string,
  listing: VenueListing,
  client: VenueHttpClient,
  errors: ManifestError[]
): Promise<VenueCoinData> {
  const premiums = listing.extra?.get('premiums') as Map<string, BinancePremium> | undefined;
  const fundingInfo = listing.extra?.get('fundingInfo') as Map<string, number> | undefined;
  const prem = premiums?.get(symbol);

  const fundingIntervalHours = fundingInfo?.get(symbol) ?? 8;
  let oiUsd: number | null = null;
  let bids: [number, number][] = [];
  let asks: [number, number][] = [];

  const oiRes = await client.requestJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
  if (oiRes.error) {
    errors.push({ ...oiRes.error, venue: 'binance' });
  } else {
    const oi = parseOpenInterest(oiRes.data);
    if (oi !== null && prem?.mark !== null && prem?.mark !== undefined) {
      oiUsd = oi * prem.mark;
    }
  }

  const depthRes = await client.requestJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`);
  if (depthRes.error) {
    errors.push({ ...depthRes.error, venue: 'binance' });
  } else {
    const depth = parseDepth(depthRes.data);
    bids = depth.bids;
    asks = depth.asks;
  }

  return {
    venue: 'binance',
    coin,
    symbol,
    fundingRate: prem?.fundingRate ?? null,
    fundingIntervalHours,
    nextFundingTime: prem?.nextFundingTime ?? null,
    mark: prem?.mark ?? null,
    index: prem?.index ?? null,
    oiUsd,
    bids,
    asks,
  };
}

async function fetchBybitCoin(
  coin: string,
  symbol: string,
  listing: VenueListing,
  client: VenueHttpClient,
  errors: ManifestError[]
): Promise<VenueCoinData> {
  const tickers = listing.extra?.get('tickers') as Map<string, BybitTicker> | undefined;
  const ticker = tickers?.get(symbol);

  let bids: [number, number][] = [];
  let asks: [number, number][] = [];

  const depthRes = await client.requestJson(
    `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=200`
  );
  if (depthRes.error) {
    errors.push({ ...depthRes.error, venue: 'bybit' });
  } else {
    const depth = parseDepth(depthRes.data);
    bids = depth.bids;
    asks = depth.asks;
  }

  return {
    venue: 'bybit',
    coin,
    symbol,
    fundingRate: ticker?.fundingRate ?? null,
    fundingIntervalHours: ticker?.fundingIntervalHours ?? null,
    nextFundingTime: ticker?.nextFundingTime ?? null,
    mark: ticker?.mark ?? null,
    index: ticker?.index ?? null,
    oiUsd: ticker?.oiUsd ?? null,
    bids,
    asks,
  };
}

async function fetchHyperliquidCoin(
  coin: string,
  rawCoin: string,
  listing: VenueListing,
  ts: number,
  client: VenueHttpClient,
  errors: ManifestError[]
): Promise<VenueCoinData> {
  const ctxs = listing.extra?.get('ctxs') as Map<string, HyperliquidCtx> | undefined;
  const ctx = ctxs?.get(rawCoin);
  const nextFundingTime = (Math.floor(ts / 3_600_000) + 1) * 3_600_000;

  let bids: [number, number][] = [];
  let asks: [number, number][] = [];

  const bookRes = await client.requestJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin: rawCoin }),
  });

  if (bookRes.error) {
    errors.push({ ...bookRes.error, venue: 'hyperliquid' });
  } else {
    const book = parseHyperliquidBook(bookRes.data);
    bids = book.bids;
    asks = book.asks;
  }

  return {
    venue: 'hyperliquid',
    coin,
    symbol: rawCoin,
    fundingRate: ctx?.fundingRate ?? null,
    fundingIntervalHours: 1,
    nextFundingTime,
    mark: ctx?.mark ?? null,
    index: ctx?.index ?? null,
    oiUsd: ctx?.oiUsd ?? null,
    bids,
    asks,
  };
}

async function fetchLighterCoin(
  coin: string,
  symbol: string,
  listing: VenueListing,
  ts: number,
  client: VenueHttpClient,
  errors: ManifestError[]
): Promise<VenueCoinData> {
  const markets = listing.extra?.get('markets') as Map<string, number> | undefined;
  const marketId = markets?.get(coin);

  if (marketId === undefined) {
    return { venue: 'lighter', coin, symbol };
  }

  let mark: number | null = null;
  let index: number | null = null;
  let oiUsd: number | null = null;
  let fundingRate: number | null = null;
  let bids: [number, number][] = [];
  let asks: [number, number][] = [];

  const detailsRes = await client.requestJson(
    `https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=${marketId}`
  );
  if (detailsRes.error) {
    errors.push({ ...detailsRes.error, venue: 'lighter' });
  } else {
    const details = parseLighterDetails(detailsRes.data);
    mark = details.mark;
    index = details.index;
    oiUsd = details.oiUsd;
  }

  const endSec = Math.floor(ts / 1000);
  const startSec = endSec - 7200;
  const fundingRes = await client.requestJson(
    `https://mainnet.zklighter.elliot.ai/api/v1/fundings?market_id=${marketId}&resolution=1h&start_timestamp=${startSec}&end_timestamp=${endSec}&count_back=2`
  );
  if (fundingRes.error) {
    errors.push({ ...fundingRes.error, venue: 'lighter' });
  } else {
    const funding = parseLighterFunding(fundingRes.data);
    fundingRate = funding.fundingRate;
  }

  const ordersRes = await client.requestJson(
    `https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=${marketId}&limit=250`
  );
  if (ordersRes.error) {
    errors.push({ ...ordersRes.error, venue: 'lighter' });
  } else {
    const orders = parseLighterOrders(ordersRes.data);
    bids = orders.bids;
    asks = orders.asks;
  }

  return {
    venue: 'lighter',
    coin,
    symbol,
    fundingRate,
    fundingIntervalHours: 1,
    nextFundingTime: null,
    mark,
    index,
    oiUsd,
    bids,
    asks,
  };
}

async function fetchAsterCoin(
  coin: string,
  symbol: string,
  listing: VenueListing,
  client: VenueHttpClient,
  errors: ManifestError[]
): Promise<VenueCoinData> {
  const premiums = listing.extra?.get('premiums') as Map<string, AsterPremium> | undefined;
  const prem = premiums?.get(symbol);

  let oiUsd: number | null = null;
  let bids: [number, number][] = [];
  let asks: [number, number][] = [];

  const oiRes = await client.requestJson(`https://fapi.asterdex.com/fapi/v1/openInterest?symbol=${symbol}`);
  if (oiRes.error) {
    errors.push({ ...oiRes.error, venue: 'aster' });
  } else {
    const oi = parseOpenInterest(oiRes.data);
    if (oi !== null && prem?.mark !== null && prem?.mark !== undefined) {
      oiUsd = oi * prem.mark;
    }
  }

  const depthRes = await client.requestJson(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${symbol}&limit=100`);
  if (depthRes.error) {
    errors.push({ ...depthRes.error, venue: 'aster' });
  } else {
    const depth = parseDepth(depthRes.data);
    bids = depth.bids;
    asks = depth.asks;
  }

  return {
    venue: 'aster',
    coin,
    symbol,
    fundingRate: prem?.fundingRate ?? null,
    fundingIntervalHours: 8,
    nextFundingTime: prem?.nextFundingTime ?? null,
    mark: prem?.mark ?? null,
    index: prem?.index ?? null,
    oiUsd,
    bids,
    asks,
  };
}

// ---------------------------------------------------------------------------
// CLI Arguments Parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): RecorderCliArgs {
  const flags = new Map<string, string>();
  const booleanFlags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const key = arg.slice(2);

    if (key === 'dry-run') {
      booleanFlags.add('dry-run');
      continue;
    }

    if (!['out', 'venues', 'coins'].includes(key)) {
      throw new Error(`Unknown flag "${arg}"`);
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for "${arg}"`);
    }
    flags.set(key, value);
    i++;
  }

  const out = flags.get('out');
  if (!out) {
    throw new Error('--out is required');
  }

  let venues: Venue[] = [...VENUES];
  if (flags.has('venues')) {
    const rawVenues = flags
      .get('venues')!
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);

    for (const v of rawVenues) {
      if (!VENUES.includes(v as Venue)) {
        throw new Error(`Invalid venue "${v}"`);
      }
    }
    venues = rawVenues as Venue[];
  }

  let coins: string[] | null = null;
  if (flags.has('coins')) {
    coins = flags
      .get('coins')!
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
  }

  return {
    out,
    venues,
    coins,
    dryRun: booleanFlags.has('dry-run'),
  };
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const startMs = Date.now();
  const ts = startMs;
  const errors: ManifestError[] = [];

  const clients: Record<Venue, VenueHttpClient> = {
    binance: new VenueHttpClient(fetch, MIN_GAP_MS),
    bybit: new VenueHttpClient(fetch, MIN_GAP_MS),
    hyperliquid: new VenueHttpClient(fetch, MIN_GAP_MS),
    lighter: new VenueHttpClient(fetch, MIN_GAP_MS),
    aster: new VenueHttpClient(fetch, MIN_GAP_MS),
  };

  const discoveryTasks: Partial<Record<Venue, Promise<VenueListing>>> = {};
  for (const v of args.venues) {
    switch (v) {
      case 'binance':
        discoveryTasks.binance = discoverBinance(clients.binance, errors);
        break;
      case 'bybit':
        discoveryTasks.bybit = discoverBybit(clients.bybit, errors);
        break;
      case 'hyperliquid':
        discoveryTasks.hyperliquid = discoverHyperliquid(clients.hyperliquid, errors);
        break;
      case 'lighter':
        discoveryTasks.lighter = discoverLighter(clients.lighter, errors);
        break;
      case 'aster':
        discoveryTasks.aster = discoverAster(clients.aster, errors);
        break;
    }
  }

  const listingsMap = new Map<Venue, VenueListing>();
  const listingSets = new Map<Venue, Set<string>>();

  for (const v of args.venues) {
    const task = discoveryTasks[v];
    if (task) {
      const listing = await task;
      listingsMap.set(v, listing);
      listingSets.set(v, new Set(listing.coinToSymbol.keys()));
    }
  }

  let coins = recordedCoins(listingSets);
  if (args.coins) {
    const requested = new Set(args.coins);
    coins = coins.filter((c) => requested.has(c));
  }

  const venueCoinData: VenueCoinData[] = [];

  const collectionTasks = args.venues.map(async (venue) => {
    const listing = listingsMap.get(venue);
    if (!listing) return;
    const client = clients[venue];

    for (const coin of coins) {
      const symbol = listing.coinToSymbol.get(coin);
      if (!symbol) continue;

      try {
        let coinData: VenueCoinData;
        switch (venue) {
          case 'binance':
            coinData = await fetchBinanceCoin(coin, symbol, listing, client, errors);
            break;
          case 'bybit':
            coinData = await fetchBybitCoin(coin, symbol, listing, client, errors);
            break;
          case 'hyperliquid':
            coinData = await fetchHyperliquidCoin(coin, symbol, listing, ts, client, errors);
            break;
          case 'lighter':
            coinData = await fetchLighterCoin(coin, symbol, listing, ts, client, errors);
            break;
          case 'aster':
            coinData = await fetchAsterCoin(coin, symbol, listing, client, errors);
            break;
        }
        venueCoinData.push(coinData);
      } catch (err: unknown) {
        errors.push({
          venue,
          call: symbol,
          status: err instanceof Error ? err.message : String(err),
        });
        venueCoinData.push({ venue, coin, symbol });
      }
    }
  });

  await Promise.all(collectionTasks);

  const rows = buildRows(ts, venueCoinData);

  const counts: Record<string, number> = {};
  for (const v of args.venues) {
    counts[v] = rows.filter((r) => r.venue === v).length;
  }

  const durationMs = Date.now() - startMs;
  const manifest: Manifest = {
    manifest: true,
    ts,
    venues: args.venues,
    coins,
    counts,
    errors,
    durationMs,
  };

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          ts,
          venues: args.venues,
          coinsCount: coins.length,
          counts,
          errorsCount: errors.length,
          durationMs,
        },
        null,
        2
      )
    );
    return 0;
  }

  const written = writeSnapshot(args.out, manifest, rows);
  console.error(`venue-recorder: snapshot written to ${written} (${rows.length} rows, ${errors.length} errors)`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
