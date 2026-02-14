import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTopSymbols, getIntervalForStyle, FALLBACK_SYMBOLS } from './top-symbols';

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
    it('should return cached symbols if available', async () => {
      const cachedSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedSymbols));

      const result = await getTopSymbols(3);

      expect(result).toEqual(cachedSymbols);
      expect(mockRedis.get).toHaveBeenCalledWith('top-symbols:24h');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should fetch from Binance if cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);

      const binanceResponse = [
        { symbol: 'BTCUSDT', quoteVolume: '1000000000' },
        { symbol: 'ETHUSDT', quoteVolume: '500000000' },
        { symbol: 'BNBUSDT', quoteVolume: '300000000' },
        { symbol: 'SOLUSDT', quoteVolume: '200000000' },
        { symbol: 'ADAUSDT', quoteVolume: '100000000' },
        { symbol: 'BTCBUSD', quoteVolume: '50000000' }, // Non-USDT, should be filtered
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      const result = await getTopSymbols(5);

      expect(result).toEqual(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT']);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'top-symbols:24h',
        expect.any(String),
        { ex: 86400 }
      );
    });

    it('should filter USDT pairs only', async () => {
      mockRedis.get.mockResolvedValue(null);

      const binanceResponse = [
        { symbol: 'BTCUSDT', quoteVolume: '1000000000' },
        { symbol: 'ETHBUSD', quoteVolume: '900000000' }, // BUSD, should be filtered
        { symbol: 'BNBUSDT', quoteVolume: '800000000' },
        { symbol: 'BTCEUR', quoteVolume: '700000000' }, // EUR, should be filtered
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      const result = await getTopSymbols(5);

      expect(result).toEqual(['BTCUSDT', 'BNBUSDT']);
      expect(result).not.toContain('ETHBUSD');
      expect(result).not.toContain('BTCEUR');
    });

    it('should sort by quoteVolume descending', async () => {
      mockRedis.get.mockResolvedValue(null);

      const binanceResponse = [
        { symbol: 'ETHUSDT', quoteVolume: '500000000' },
        { symbol: 'BTCUSDT', quoteVolume: '1000000000' },
        { symbol: 'ADAUSDT', quoteVolume: '100000000' },
        { symbol: 'SOLUSDT', quoteVolume: '200000000' },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      const result = await getTopSymbols(5);

      // Should be sorted by volume
      expect(result[0]).toBe('BTCUSDT'); // Highest volume
      expect(result[1]).toBe('ETHUSDT');
      expect(result[2]).toBe('SOLUSDT');
      expect(result[3]).toBe('ADAUSDT'); // Lowest volume
    });

    it('should cache fetched symbols for 24 hours', async () => {
      mockRedis.get.mockResolvedValue(null);

      const binanceResponse = [
        { symbol: 'BTCUSDT', quoteVolume: '1000000000' },
        { symbol: 'ETHUSDT', quoteVolume: '500000000' },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      await getTopSymbols(5);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'top-symbols:24h',
        expect.stringContaining('BTCUSDT'),
        { ex: 86400 }
      );
    });

    it('should return fallback symbols on API error', async () => {
      mockRedis.get.mockResolvedValue(null);

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const result = await getTopSymbols(5);

      expect(result).toEqual(FALLBACK_SYMBOLS);
    });

    it('should return fallback symbols on fetch exception', async () => {
      mockRedis.get.mockResolvedValue(null);

      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      const result = await getTopSymbols(5);

      expect(result).toEqual(FALLBACK_SYMBOLS);
    });

    it('should return fallback symbols if no USDT pairs found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const binanceResponse = [
        { symbol: 'BTCBUSD', quoteVolume: '1000000000' },
        { symbol: 'ETHBUSD', quoteVolume: '500000000' },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      const result = await getTopSymbols(5);

      expect(result).toEqual(FALLBACK_SYMBOLS);
    });

    it('should force refresh when forceRefresh=true', async () => {
      const cachedSymbols = ['BTCUSDT', 'ETHUSDT'];
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedSymbols));

      const binanceResponse = [
        { symbol: 'SOLUSDT', quoteVolume: '1000000000' },
        { symbol: 'ADAUSDT', quoteVolume: '500000000' },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      const result = await getTopSymbols(2, true);

      expect(result).toEqual(['SOLUSDT', 'ADAUSDT']);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should limit results to requested count', async () => {
      mockRedis.get.mockResolvedValue(null);

      const binanceResponse = [
        { symbol: 'BTCUSDT', quoteVolume: '1000000000' },
        { symbol: 'ETHUSDT', quoteVolume: '900000000' },
        { symbol: 'BNBUSDT', quoteVolume: '800000000' },
        { symbol: 'SOLUSDT', quoteVolume: '700000000' },
        { symbol: 'ADAUSDT', quoteVolume: '600000000' },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      const result = await getTopSymbols(3);

      expect(result).toHaveLength(3);
      expect(result).toEqual(['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
    });

    it('should handle cached list longer than requested count', async () => {
      const cachedSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT'];
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedSymbols));

      const result = await getTopSymbols(3);

      expect(result).toEqual(['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
    });

    it('should filter out invalid quoteVolume values', async () => {
      mockRedis.get.mockResolvedValue(null);

      const binanceResponse = [
        { symbol: 'BTCUSDT', quoteVolume: '1000000000' },
        { symbol: 'ETHUSDT', quoteVolume: 'invalid' }, // Invalid, should be filtered
        { symbol: 'BNBUSDT', quoteVolume: '500000000' },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => binanceResponse,
      } as Response);

      const result = await getTopSymbols(5);

      expect(result).toEqual(['BTCUSDT', 'BNBUSDT']);
      expect(result).not.toContain('ETHUSDT');
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
