import type { OHLCV, Ticker24h, Symbol } from '@/types/market';

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
  limit = 500
): Promise<OHLCV[]> {
  const res = await fetch(
    `${getBaseUrl()}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
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
