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
  limit = 1
): Promise<FundingRate[]> {
  const params = new URLSearchParams({ symbol, limit: String(limit) });
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
