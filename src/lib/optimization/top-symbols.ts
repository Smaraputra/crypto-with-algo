import { redis } from '@/lib/redis';
import { fetchTickers } from '@/lib/binance';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export interface SymbolVolume {
  symbol: string;
  quoteVolume: number; // 24hr USDT volume
}

/**
 * Fallback symbols if Binance API fails
 */
export const FALLBACK_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT'];

/**
 * Top N symbols by 24hr quote volume, drawn from SIGNAL_SYMBOLS only.
 * Caches results in Redis for 24hrs.
 *
 * Ranking the whole Binance USDT market is wrong for optimization: stablecoin
 * pairs lead it (USDCUSDT, USD1USDT), and any symbol outside SIGNAL_SYMBOLS has
 * no stored snapshots, so its backtests would run without futures or sentiment
 * data. The orchestrator assigns symbols to styles round-robin, so the first
 * entries matter most.
 */
export async function getTopSymbols(
  count: number = 5,
  forceRefresh: boolean = false
): Promise<string[]> {
  const cacheKey = 'top-symbols:signal-universe:24h';

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

    // Uses the shared client so BINANCE_API_URL keeps one meaning everywhere.
    // It already includes /api/v3; appending it again here produced a 404 in
    // production and silently fell back on every run.
    const universe = new Set<string>(SIGNAL_SYMBOLS);
    const ranked = (await fetchTickers())
      .filter((t) => universe.has(t.symbol))
      .map((t) => ({ symbol: t.symbol, quoteVolume: parseFloat(t.quoteVolume) }))
      .filter((t) => !isNaN(t.quoteVolume))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);

    const topSymbols = ranked.slice(0, Math.max(count, 10)).map((p) => p.symbol);

    if (topSymbols.length === 0) {
      console.error('No signal symbols found in Binance ticker response');
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
