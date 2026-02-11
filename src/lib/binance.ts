import type { OHLCV, Ticker24h, TickerPrice, Symbol } from '@/types/market';

const DEFAULT_BASE_URL = 'https://api.binance.com/api/v3';

function getBaseUrl(): string {
  return process.env.BINANCE_API_URL || DEFAULT_BASE_URL;
}

export async function fetchTickers(): Promise<Ticker24h[]> {
  const res = await fetch(`${getBaseUrl()}/ticker/24hr`);
  if (!res.ok) {
    throw new Error(`Failed to fetch tickers: HTTP ${res.status}`);
  }

  const data: Ticker24h[] = await res.json();
  return data.filter((t) => t.symbol.endsWith('USDT'));
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 500,
  startTime?: number,
  endTime?: number
): Promise<OHLCV[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });
  if (startTime !== undefined) params.set('startTime', String(startTime));
  if (endTime !== undefined) params.set('endTime', String(endTime));

  const res = await fetch(`${getBaseUrl()}/klines?${params}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch klines for ${symbol}: HTTP ${res.status}`);
  }

  const data: unknown[][] = await res.json();
  return data.map((k) => ({
    timestamp: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

export async function fetchTickerPrices(
  symbols: string[]
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const params = new URLSearchParams({
    symbols: JSON.stringify(symbols),
  });

  const res = await fetch(`${getBaseUrl()}/ticker/price?${params}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ticker prices: HTTP ${res.status}`);
  }

  const data: TickerPrice[] = await res.json();
  const result: Record<string, number> = {};
  for (const item of data) {
    result[item.symbol] = parseFloat(item.price);
  }
  return result;
}

const KLINES_PAGE_SIZE = 1000;
const RATE_LIMIT_DELAY_MS = 200;

export async function fetchKlinesRange(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  onProgress?: (fetched: number) => void
): Promise<OHLCV[]> {
  const allCandles: OHLCV[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const batch = await fetchKlines(
      symbol,
      interval,
      KLINES_PAGE_SIZE,
      cursor,
      endTime
    );

    if (batch.length === 0) break;

    allCandles.push(...batch);
    onProgress?.(allCandles.length);

    const lastTimestamp = batch[batch.length - 1].timestamp;
    cursor = lastTimestamp + 1;

    if (batch.length < KLINES_PAGE_SIZE) break;

    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  // Deduplicate by timestamp (shouldn't happen, but defensive)
  const seen = new Set<number>();
  return allCandles.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });
}

export async function fetchSymbols(): Promise<Symbol[]> {
  const res = await fetch(`${getBaseUrl()}/exchangeInfo`);
  if (!res.ok) {
    throw new Error(`Failed to fetch exchange info: HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.symbols
    .filter(
      (s: { status: string; quoteAsset: string }) =>
        s.status === 'TRADING' && s.quoteAsset === 'USDT'
    )
    .map((s: { symbol: string; baseAsset: string; quoteAsset: string }) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
    }));
}
