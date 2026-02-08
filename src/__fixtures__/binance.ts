import type { Ticker24h, OHLCV } from '@/types/market';

export const mockTickers: Ticker24h[] = [
  {
    symbol: 'BTCUSDT',
    lastPrice: '40500.00',
    priceChange: '500.00',
    priceChangePercent: '1.25',
    highPrice: '41000.00',
    lowPrice: '39500.00',
    volume: '1000.50',
    quoteVolume: '40500000.00',
    openPrice: '40000.00',
    count: 50000,
  },
  {
    symbol: 'ETHUSDT',
    lastPrice: '2550.00',
    priceChange: '50.00',
    priceChangePercent: '2.00',
    highPrice: '2600.00',
    lowPrice: '2450.00',
    volume: '5000.00',
    quoteVolume: '12750000.00',
    openPrice: '2500.00',
    count: 30000,
  },
];

export const mockOHLCV: OHLCV[] = [
  { timestamp: 1700000000000, open: 40000, high: 41000, low: 39500, close: 40500, volume: 1000 },
  { timestamp: 1700003600000, open: 40500, high: 42000, low: 40000, close: 41500, volume: 1200 },
  { timestamp: 1700007200000, open: 41500, high: 41800, low: 41000, close: 41200, volume: 800 },
];
