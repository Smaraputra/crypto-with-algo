import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { getCachedCandles, setCachedCandles, clearCandleCache } from './candle-cache';
import type { OHLCV } from '@/types/market';

const testCandles: OHLCV[] = [
  { timestamp: 1000, open: 100, high: 105, low: 95, close: 102, volume: 1000 },
  { timestamp: 2000, open: 102, high: 108, low: 100, close: 106, volume: 1200 },
  { timestamp: 3000, open: 106, high: 110, low: 104, close: 108, volume: 900 },
];

beforeEach(async () => {
  await clearCandleCache();
});

describe('candle-cache', () => {
  it('returns null for cache miss', async () => {
    const result = await getCachedCandles('BTCUSDT', '1h');
    expect(result).toBeNull();
  });

  it('stores and retrieves candles', async () => {
    await setCachedCandles('BTCUSDT', '1h', testCandles);
    const result = await getCachedCandles('BTCUSDT', '1h');

    expect(result).toHaveLength(3);
    expect(result![0].timestamp).toBe(1000);
    expect(result![2].close).toBe(108);
  });

  it('returns different entries for different keys', async () => {
    await setCachedCandles('BTCUSDT', '1h', testCandles);
    await setCachedCandles('ETHUSDT', '1h', [testCandles[0]]);

    const btc = await getCachedCandles('BTCUSDT', '1h');
    const eth = await getCachedCandles('ETHUSDT', '1h');

    expect(btc).toHaveLength(3);
    expect(eth).toHaveLength(1);
  });

  it('clears cache', async () => {
    await setCachedCandles('BTCUSDT', '1h', testCandles);
    await clearCandleCache();

    const result = await getCachedCandles('BTCUSDT', '1h');
    expect(result).toBeNull();
  });

  it('overwrites existing entry on same key', async () => {
    await setCachedCandles('BTCUSDT', '1h', testCandles);
    await setCachedCandles('BTCUSDT', '1h', [testCandles[0]]);

    const result = await getCachedCandles('BTCUSDT', '1h');
    expect(result).toHaveLength(1);
  });
});
