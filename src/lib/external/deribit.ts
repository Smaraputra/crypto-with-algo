/**
 * Deribit public API client: the DVOL implied-volatility index and option
 * trade history.
 *
 * Two hosts, both plain JSON-RPC-over-HTTP with no auth for these endpoints:
 *
 *   www.deribit.com      `public/get_volatility_index_data` -- DVOL, hourly
 *                         since 2021-03-24, up to 1000 rows per call, rows
 *                         ascending, paged BACKWARD via `continuation` (the
 *                         end timestamp of the next, older page).
 *   history.deribit.com  `public/get_last_trades_by_currency_and_time` --
 *                         every option trade since 2019, NEWEST FIRST within
 *                         a page, up to 10000 rows per call (20k-30k trades
 *                         a day per currency), paged BACKWARD by moving
 *                         `end_timestamp` to the oldest trade on the page.
 *
 * Verified against the live API on 2026-09-28 (see the task brief this file
 * implements). JSON-RPC errors come back as `{ error: { code, message } }`
 * with either HTTP 200 or 400, so the error body is always inspected before
 * deciding whether a 4xx is fatal.
 *
 * The retry shape mirrors `fetchArchiveFile` in `./binance-archive.ts`: four
 * attempts, backoff `retryBaseMs * 2 ** (attempt - 1)`, `retryBaseMs`
 * injectable so tests run with none. On top of that, a module-level throttle
 * paces every outgoing request (including retries) at least `minGapMs` apart,
 * because Deribit's public endpoints are rate limited per IP; tests pass
 * `minGapMs: 0` to disable it.
 */

import { normalCdf, normalPdf } from '@/lib/stats/normal';

export const DERIBIT_API_URL = 'https://www.deribit.com/api/v2';
export const DERIBIT_HISTORY_URL = 'https://history.deribit.com/api/v2';

export type DeribitCurrency = 'BTC' | 'ETH';
export const DERIBIT_CURRENCIES: readonly DeribitCurrency[] = ['BTC', 'ETH'];

export interface DvolRow {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OptionTrade {
  timestamp: number;
  tradeId: string;
  tradeSeq: number;
  instrumentName: string;
  direction: 'buy' | 'sell';
  price: number;
  markPrice: number | null;
  /** Implied volatility in PERCENT (e.g. 65.3 for 65.3%), as Deribit reports it. */
  iv: number | null;
  indexPrice: number;
  amount: number;
  contracts: number | null;
}

export interface DeribitFetchOptions {
  /** Base backoff in ms. Tests pass 0; nothing in production should set it. */
  retryBaseMs?: number;
  /** Minimum gap between outgoing requests, in ms. Tests pass 0. */
  minGapMs?: number;
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

export function dvolUrl(
  currency: DeribitCurrency,
  startMs: number,
  endMs: number,
  resolutionSec: number | '1D'
): string {
  const params = new URLSearchParams({
    currency,
    start_timestamp: String(startMs),
    end_timestamp: String(endMs),
    resolution: String(resolutionSec),
  });
  return `${DERIBIT_API_URL}/public/get_volatility_index_data?${params.toString()}`;
}

export function optionTradesUrl(
  currency: DeribitCurrency,
  startMs: number,
  endMs: number,
  count: number
): string {
  const params = new URLSearchParams({
    currency,
    kind: 'option',
    start_timestamp: String(startMs),
    end_timestamp: String(endMs),
    count: String(count),
    include_old: 'true',
  });
  return `${DERIBIT_HISTORY_URL}/public/get_last_trades_by_currency_and_time?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Fetching: retry, throttle, JSON-RPC error handling
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const DEFAULT_MIN_GAP_MS = 334;
const FETCH_TIMEOUT_MS = 30_000;

/** JSON-RPC too_many_requests, retried like a 429 rather than thrown. */
const TOO_MANY_REQUESTS_CODE = 10028;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Last time any request actually went out, so the throttle below is shared across calls. */
let lastRequestAt = 0;

async function throttle(minGapMs: number): Promise<void> {
  if (minGapMs > 0) {
    const wait = lastRequestAt + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
  }
  lastRequestAt = Date.now();
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * One JSON-RPC GET against a Deribit host, with retry and throttle.
 *
 * Retries on a network error, HTTP 429, HTTP 5xx, and JSON-RPC error code
 * 10028 (too_many_requests). Throws immediately on any other 4xx and any
 * other JSON-RPC error, since those are not transient.
 */
async function deribitRequest<T>(url: string, options: DeribitFetchOptions): Promise<T> {
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && retryBaseMs > 0) await sleep(retryBaseMs * 2 ** (attempt - 1));
    await throttle(minGapMs);

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      lastError = error;
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Deribit fetch failed: HTTP ${res.status} for ${url}`);
      continue;
    }

    let json: JsonRpcResponse<T>;
    try {
      json = (await res.json()) as JsonRpcResponse<T>;
    } catch (parseError) {
      if (!res.ok) throw new Error(`Deribit fetch failed: HTTP ${res.status} for ${url}`);
      throw parseError;
    }

    if (json.error) {
      if (json.error.code === TOO_MANY_REQUESTS_CODE) {
        lastError = new Error(`Deribit rate limited (${json.error.code}): ${json.error.message}`);
        continue;
      }
      throw new Error(`Deribit error ${json.error.code}: ${json.error.message}`);
    }

    if (!res.ok) {
      throw new Error(`Deribit fetch failed: HTTP ${res.status} for ${url}`);
    }

    return json.result as T;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Deribit fetch failed after ${MAX_ATTEMPTS} attempts for ${url}`);
}

// ---------------------------------------------------------------------------
// DVOL
// ---------------------------------------------------------------------------

interface DvolResult {
  data: [number, number, number, number, number][];
  continuation: number | null;
}

/**
 * DVOL rows for [startMs, endMs], following `continuation` backward until it
 * is null or a page comes back empty. Returns rows ascending by timestamp,
 * deduplicated (pages can overlap at the boundary the continuation moves to).
 */
export async function fetchDvol(
  currency: DeribitCurrency,
  startMs: number,
  endMs: number,
  resolutionSec: number | '1D',
  options: DeribitFetchOptions = {}
): Promise<DvolRow[]> {
  const rows = new Map<number, DvolRow>();
  let end = endMs;

  for (;;) {
    const url = dvolUrl(currency, startMs, end, resolutionSec);
    const result = await deribitRequest<DvolResult>(url, options);
    const page = result.data ?? [];
    if (page.length === 0) break;

    for (const [timestamp, open, high, low, close] of page) {
      rows.set(timestamp, { timestamp, open, high, low, close });
    }

    if (result.continuation === null || result.continuation === undefined) break;
    end = result.continuation;
  }

  return Array.from(rows.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Option trades
// ---------------------------------------------------------------------------

const OPTION_TRADES_COUNT = 10000;

interface RawOptionTrade {
  trade_seq: number;
  trade_id: string;
  timestamp: number;
  price: number;
  mark_price?: number | null;
  iv?: number | null;
  instrument_name: string;
  index_price: number;
  direction: 'buy' | 'sell';
  amount: number;
  contracts?: number | null;
}

interface OptionTradesResult {
  trades: RawOptionTrade[];
  has_more: boolean;
}

function toOptionTrade(raw: RawOptionTrade): OptionTrade {
  return {
    timestamp: raw.timestamp,
    tradeId: raw.trade_id,
    tradeSeq: raw.trade_seq,
    instrumentName: raw.instrument_name,
    direction: raw.direction,
    price: raw.price,
    markPrice: raw.mark_price ?? null,
    iv: raw.iv ?? null,
    indexPrice: raw.index_price,
    amount: raw.amount,
    contracts: raw.contracts ?? null,
  };
}

/**
 * Option trades for [startMs, endMs], paged backward: each next page's
 * `end_timestamp` is the OLDEST timestamp seen on the previous page
 * (inclusive, so pages overlap by at least one trade at the boundary).
 * Dedupes by `tradeId` and stops when a page reports `has_more: false` or
 * adds no id the accumulator did not already have. Returns ascending by
 * (timestamp, tradeSeq).
 */
export async function fetchOptionTrades(
  currency: DeribitCurrency,
  startMs: number,
  endMs: number,
  options: DeribitFetchOptions = {}
): Promise<OptionTrade[]> {
  const byId = new Map<string, OptionTrade>();
  let end = endMs;

  for (;;) {
    const url = optionTradesUrl(currency, startMs, end, OPTION_TRADES_COUNT);
    const result = await deribitRequest<OptionTradesResult>(url, options);
    const page = result.trades ?? [];
    if (page.length === 0) break;

    let addedNew = false;
    let oldestTimestamp = Infinity;
    for (const raw of page) {
      if (raw.timestamp < oldestTimestamp) oldestTimestamp = raw.timestamp;
      if (!byId.has(raw.trade_id)) {
        byId.set(raw.trade_id, toOptionTrade(raw));
        addedNew = true;
      }
    }

    if (!result.has_more || !addedNew) break;
    end = oldestTimestamp;
  }

  return Array.from(byId.values()).sort(
    (a, b) => a.timestamp - b.timestamp || a.tradeSeq - b.tradeSeq
  );
}

// ---------------------------------------------------------------------------
// Instrument parsing
// ---------------------------------------------------------------------------

export interface ParsedInstrument {
  currency: string;
  expiryMs: number;
  strike: number;
  isCall: boolean;
}

const INSTRUMENT_RE = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/;

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/**
 * Parses a Deribit option instrument name, e.g. 'BTC-28JAN22-56000-C'.
 * Null for anything that is not exactly that shape: perpetuals
 * ('BTC-PERPETUAL'), futures and futures spreads ('BTC-FS-...'), and a
 * malformed month code. A 'd' in the strike segment stands in for a decimal
 * point ('3000d5' -> 3000.5), which Deribit uses because '.' is not legal in
 * an instrument name. Expiry is always 08:00 UTC on the given date.
 */
export function parseInstrument(name: string): ParsedInstrument | null {
  const match = INSTRUMENT_RE.exec(name);
  if (!match) return null;

  const [, currency, dayStr, monthStr, yearStr, strikeStr, optionType] = match;
  const month = MONTHS[monthStr];
  if (month === undefined) return null;

  const day = Number(dayStr);
  const year = 2000 + Number(yearStr);
  const expiryMs = Date.UTC(year, month, day, 8, 0, 0);

  const strike = Number(strikeStr.replace('d', '.'));
  if (!Number.isFinite(strike)) return null;

  return { currency, expiryMs, strike, isCall: optionType === 'C' };
}

// ---------------------------------------------------------------------------
// Black-Scholes greeks (r = 0)
// ---------------------------------------------------------------------------

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export function yearsToExpiry(expiryMs: number, atMs: number): number {
  return (expiryMs - atMs) / MS_PER_YEAR;
}

function validInputs(spot: number, strike: number, tauYears: number, sigma: number): boolean {
  return (
    Number.isFinite(spot) &&
    spot > 0 &&
    Number.isFinite(strike) &&
    strike > 0 &&
    Number.isFinite(tauYears) &&
    tauYears > 0 &&
    Number.isFinite(sigma) &&
    sigma > 0
  );
}

function d1(spot: number, strike: number, tauYears: number, sigma: number): number {
  return (Math.log(spot / strike) + 0.5 * sigma * sigma * tauYears) / (sigma * Math.sqrt(tauYears));
}

/** Black-Scholes delta with r = 0. NaN when any input is not finite or <= 0. */
export function blackScholesDelta(
  spot: number,
  strike: number,
  tauYears: number,
  sigma: number,
  isCall: boolean
): number {
  if (!validInputs(spot, strike, tauYears, sigma)) return NaN;
  const callDelta = normalCdf(d1(spot, strike, tauYears, sigma));
  return isCall ? callDelta : callDelta - 1;
}

/** Black-Scholes gamma with r = 0, the same for calls and puts. NaN under the same conditions as blackScholesDelta. */
export function blackScholesGamma(spot: number, strike: number, tauYears: number, sigma: number): number {
  if (!validInputs(spot, strike, tauYears, sigma)) return NaN;
  return normalPdf(d1(spot, strike, tauYears, sigma)) / (spot * sigma * Math.sqrt(tauYears));
}
