import { redis } from '@/lib/redis';

export interface SymbolVolume {
  symbol: string;
  quoteVolume: number; // 24hr USDT volume
}

/**
 * Fallback symbols if Binance API fails
 */
export const FALLBACK_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT'];

/**
 * Fetch top N USDT symbols by 24hr volume from Binance
 * Caches results in Redis for 24hrs
 */
export async function getTopSymbols(
  count: number = 5,
  forceRefresh: boolean = false
): Promise<string[]> {
  const cacheKey = 'top-symbols:24h';

  try {
    // Check cache first
    if (!forceRefresh && redis) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const symbols = JSON.parse(cached as string) as string[];
        if (symbols.length >= count) {
          return symbols.slice(0, count);
        }
      }
    }

    // Fetch from Binance
    const binanceUrl = process.env.BINANCE_API_URL || 'https://api.binance.com';
    const response = await fetch(`${binanceUrl}/api/v3/ticker/24hr`);

    if (!response.ok) {
      console.error('Binance API error:', response.status, response.statusText);
      return FALLBACK_SYMBOLS.slice(0, count);
    }

    interface BinanceTicker {
      symbol: string;
      quoteVolume: string;
    }

    const tickers = (await response.json()) as BinanceTicker[];

    // Filter for USDT pairs only
    const usdtPairs = tickers
      .filter((t) => t.symbol.endsWith('USDT'))
      .map((t) => ({
        symbol: t.symbol,
        quoteVolume: parseFloat(t.quoteVolume),
      }))
      .filter((t) => !isNaN(t.quoteVolume));

    // Sort by volume descending
    usdtPairs.sort((a, b) => b.quoteVolume - a.quoteVolume);

    // Take top symbols
    const topSymbols = usdtPairs.slice(0, Math.max(count, 10)).map((p) => p.symbol);

    if (topSymbols.length === 0) {
      console.error('No USDT pairs found in Binance response');
      return FALLBACK_SYMBOLS.slice(0, count);
    }

    // Cache for 24 hours
    if (redis) {
      await redis.set(cacheKey, JSON.stringify(topSymbols), { ex: 86400 });
    }

    return topSymbols.slice(0, count);
  } catch (error) {
    console.error('Error fetching top symbols:', error);
    return FALLBACK_SYMBOLS.slice(0, count);
  }
}

/**
 * Get interval appropriate for trading style
 */
export function getIntervalForStyle(style: string): string {
  switch (style) {
    case 'scalping':
      return '5m';
    case 'day_trading':
      return '1h';
    case 'swing_trading':
      return '4h';
    case 'position_trading':
      return '1d';
    default:
      return '1h';
  }
}

/**
 * Historical window, in months, for a style's optimization run.
 *
 * A single shared window cannot serve every style: walk-forward needs at least
 * minTrainingBars + testWindowBars (400) bars, so six months of daily candles
 * (~180) starved position_trading outright, while six months of 5m candles
 * (~52,000) both overshot the 50,000-row read cap and produced ~171 windows.
 * These values clear the 400-bar floor for every style and keep the largest
 * series under that cap.
 */
export function getMonthsForStyle(style: string): number {
  switch (style) {
    case 'scalping':
      return 3; // ~25,900 bars at 5m
    case 'day_trading':
      return 12; // ~8,700 bars at 1h
    case 'swing_trading':
      return 24; // ~4,300 bars at 4h
    case 'position_trading':
      return 48; // ~1,440 bars at 1d
    default:
      return 12;
  }
}
