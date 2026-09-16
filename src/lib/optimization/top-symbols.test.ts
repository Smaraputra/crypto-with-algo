import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTopSymbols,
  getIntervalForStyle,
  getMonthsForStyle,
  FALLBACK_SYMBOLS,
} from './top-symbols';
import { DEFAULT_OPTIMIZATION_CONFIG } from '@/types/optimization';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

// Mock Redis using vi.hoisted
const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  redis: mockRedis,
}));

// Mock fetch
global.fetch = vi.fn();

describe('top-symbols', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getTopSymbols', () => {
    const CACHE_KEY = 'top-symbols:signal-universe:24h';

    function mockTickers(tickers: Array<{ symbol: string; quoteVolume: string }>) {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => tickers,
      } as Response);
    }

    // Shaped after the live ranking on 2026-09-16: a stablecoin pair leads the
    // USDT market and short-lived spikes sit between the majors.
    const liveLikeTickers = [
      { symbol: 'USDCUSDT', quoteVolume: '3043000000' },
      { symbol: 'BTCUSDT', quoteVolume: '1395000000' },
      { symbol: 'ETHUSDT', quoteVolume: '895000000' },
      { symbol: 'XRPUSDT', quoteVolume: '374000000' },
      { symbol: 'ZECUSDT', quoteVolume: '343000000' },
      { symbol: 'SOLUSDT', quoteVolume: '267000000' },
      { symbol: 'USD1USDT', quoteVolume: '143000000' },
      { symbol: 'BNBUSDT', quoteVolume: '98000000' },
      { symbol: 'DOGEUSDT', quoteVolume: '68000000' },
      { symbol: 'BTCBUSD', quoteVolume: '50000000' },
    ];

    it('returns cached symbols without calling Binance', async () => {
      const cachedSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedSymbols));

      const result = await getTopSymbols(3);

      expect(result).toEqual(cachedSymbols);
      expect(mockRedis.get).toHaveBeenCalledWith(CACHE_KEY);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('never selects a stablecoin pair, even when it leads the market', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockTickers(liveLikeTickers);

      const result = await getTopSymbols(10);

      expect(result).not.toContain('USDCUSDT');
      expect(result).not.toContain('USD1USDT');
    });

    it('only selects symbols that have stored snapshots and signals', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockTickers(liveLikeTickers);

      const result = await getTopSymbols(10);

      for (const symbol of result) {
        expect(SIGNAL_SYMBOLS as readonly string[]).toContain(symbol);
      }
      expect(result).not.toContain('ZECUSDT');
      expect(result).not.toContain('BTCBUSD');
    });

    it('ranks the signal universe by 24h quote volume', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockTickers(liveLikeTickers);

      // Round-robin assignment means these four go to the four styles in order.
      await expect(getTopSymbols(4)).resolves.toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT']);
    });

    it('requests tickers once under BINANCE_API_URL, which already carries /api/v3', async () => {
      const previous = process.env.BINANCE_API_URL;
      process.env.BINANCE_API_URL = 'https://api.binance.com/api/v3';
      mockRedis.get.mockResolvedValue(null);
      mockTickers(liveLikeTickers);

      await getTopSymbols(5);

      const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toBe('https://api.binance.com/api/v3/ticker/24hr');
      expect(url.match(/\/api\/v3/g)).toHaveLength(1);

      if (previous === undefined) delete process.env.BINANCE_API_URL;
      else process.env.BINANCE_API_URL = previous;
    });

    it('caches the ranked universe for 24 hours', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockTickers(liveLikeTickers);

      await getTopSymbols(5);

      expect(mockRedis.set).toHaveBeenCalledWith(
        CACHE_KEY,
        JSON.stringify(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT']),
        { ex: 86400 }
      );
    });

    it('falls back on a non-ok response', async () => {
      mockRedis.get.mockResolvedValue(null);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(getTopSymbols(5)).resolves.toEqual(FALLBACK_SYMBOLS);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('falls back on a network error', async () => {
      mockRedis.get.mockResolvedValue(null);
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(getTopSymbols(5)).resolves.toEqual(FALLBACK_SYMBOLS);
    });

    it('falls back when no signal symbol appears in the response', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockTickers([
        { symbol: 'USDCUSDT', quoteVolume: '3043000000' },
        { symbol: 'ZECUSDT', quoteVolume: '343000000' },
      ]);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(getTopSymbols(5)).resolves.toEqual(FALLBACK_SYMBOLS);
    });

    it('bypasses the cache when forceRefresh is set', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(['ADAUSDT', 'DOTUSDT', 'LINKUSDT']));
      mockTickers(liveLikeTickers);

      const result = await getTopSymbols(3, true);

      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(result).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT']);
    });

    it('ignores a cached list shorter than the requested count', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(['BTCUSDT']));
      mockTickers(liveLikeTickers);

      await expect(getTopSymbols(3)).resolves.toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT']);
    });

    it('drops entries with an unparseable volume', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockTickers([
        { symbol: 'BTCUSDT', quoteVolume: '1395000000' },
        { symbol: 'ETHUSDT', quoteVolume: 'not-a-number' },
        { symbol: 'SOLUSDT', quoteVolume: '267000000' },
      ]);

      await expect(getTopSymbols(2)).resolves.toEqual(['BTCUSDT', 'SOLUSDT']);
    });
  });

  describe('getIntervalForStyle', () => {
    it('should return 5m for scalping', () => {
      expect(getIntervalForStyle('scalping')).toBe('5m');
    });

    it('should return 1h for day_trading', () => {
      expect(getIntervalForStyle('day_trading')).toBe('1h');
    });

    it('should return 4h for swing_trading', () => {
      expect(getIntervalForStyle('swing_trading')).toBe('4h');
    });

    it('should return 1d for position_trading', () => {
      expect(getIntervalForStyle('position_trading')).toBe('1d');
    });

    it('should return 1h for unknown style', () => {
      expect(getIntervalForStyle('unknown')).toBe('1h');
    });
  });
});

describe('getMonthsForStyle', () => {
  // Bars produced per month, derived from the interval each style optimizes on.
  const BARS_PER_MONTH: Record<string, number> = {
    scalping: 30 * 24 * 12, // 5m
    day_trading: 30 * 24, // 1h
    swing_trading: 30 * 6, // 4h
    position_trading: 30, // 1d
  };
  const MIN_BARS =
    DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars + DEFAULT_OPTIMIZATION_CONFIG.testWindowBars;
  const READ_CAP = 50000;

  it.each(Object.keys(BARS_PER_MONTH))(
    'gives %s enough bars to clear the walk-forward floor',
    (style) => {
      const bars = getMonthsForStyle(style) * BARS_PER_MONTH[style];

      expect(bars).toBeGreaterThan(MIN_BARS);
    }
  );

  it('keeps position_trading above the floor that six months could never reach', () => {
    // The pre-fix behaviour: a flat 6-month window yields ~180 daily bars.
    expect(6 * BARS_PER_MONTH.position_trading).toBeLessThan(MIN_BARS);
    expect(getMonthsForStyle('position_trading') * BARS_PER_MONTH.position_trading)
      .toBeGreaterThan(MIN_BARS);
  });

  it('keeps every series under the 50,000-row candle read cap', () => {
    for (const style of Object.keys(BARS_PER_MONTH)) {
      expect(getMonthsForStyle(style) * BARS_PER_MONTH[style]).toBeLessThan(READ_CAP);
    }
  });

  it('falls back to the day_trading window for an unknown style', () => {
    expect(getMonthsForStyle('nonsense')).toBe(getMonthsForStyle('day_trading'));
  });
});
