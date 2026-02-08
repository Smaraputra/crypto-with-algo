import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MockWebSocket } from '@/test/mock-websocket';

vi.stubGlobal('WebSocket', MockWebSocket);

describe('useBinanceTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.resetMock();
    vi.stubEnv('NEXT_PUBLIC_BINANCE_WS_URL', 'wss://test-ws.example.com');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function importModule() {
    // Dynamic import to pick up env stubs
    const mod = await import('./useBinanceStream');
    return mod;
  }

  it('builds correct combined stream URL', async () => {
    const { useBinanceTicker } = await importModule();
    renderHook(() => useBinanceTicker(['BTCUSDT', 'ETHUSDT']));

    expect(MockWebSocket.lastInstance!.url).toBe(
      'wss://test-ws.example.com/stream?streams=btcusdt@ticker/ethusdt@ticker'
    );
  });

  it('returns no connection for empty symbols array', async () => {
    const { useBinanceTicker } = await importModule();
    const { result } = renderHook(() => useBinanceTicker([]));

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.isConnected).toBe(false);
  });

  it('updates tickers from messages', async () => {
    const { useBinanceTicker } = await importModule();
    const { result } = renderHook(() => useBinanceTicker(['BTCUSDT']));

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          s: 'BTCUSDT',
          p: '500.00',
          P: '1.25',
          c: '40500.00',
          o: '40000.00',
          h: '41000.00',
          l: '39500.00',
          v: '1000.50',
          q: '40500000.00',
          n: 50000,
        },
      });
    });

    expect(result.current.tickers).toHaveProperty('BTCUSDT');
    const ticker = result.current.tickers['BTCUSDT'];
    expect(ticker.symbol).toBe('BTCUSDT');
    expect(ticker.lastPrice).toBe('40500.00');
    expect(ticker.priceChange).toBe('500.00');
    expect(ticker.priceChangePercent).toBe('1.25');
    expect(ticker.highPrice).toBe('41000.00');
    expect(ticker.lowPrice).toBe('39500.00');
    expect(ticker.volume).toBe('1000.50');
    expect(ticker.quoteVolume).toBe('40500000.00');
    expect(ticker.openPrice).toBe('40000.00');
    expect(ticker.count).toBe(50000);
  });

  it('handles multiple symbols updating independently', async () => {
    const { useBinanceTicker } = await importModule();
    const { result } = renderHook(() =>
      useBinanceTicker(['BTCUSDT', 'ETHUSDT'])
    );

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateMessage({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker', s: 'BTCUSDT', p: '500', P: '1.25',
          c: '40500', o: '40000', h: '41000', l: '39500',
          v: '1000', q: '40500000', n: 50000,
        },
      });
    });

    act(() => {
      ws.simulateMessage({
        stream: 'ethusdt@ticker',
        data: {
          e: '24hrTicker', s: 'ETHUSDT', p: '50', P: '2.00',
          c: '2550', o: '2500', h: '2600', l: '2450',
          v: '5000', q: '12750000', n: 30000,
        },
      });
    });

    expect(result.current.tickers['BTCUSDT'].lastPrice).toBe('40500');
    expect(result.current.tickers['ETHUSDT'].lastPrice).toBe('2550');
  });

  it('falls back to default URL when env var unset', async () => {
    vi.unstubAllEnvs();
    // Re-import to pick up the cleared env
    vi.resetModules();
    MockWebSocket.resetMock();

    const { useBinanceTicker } = await import('./useBinanceStream');
    renderHook(() => useBinanceTicker(['BTCUSDT']));

    expect(MockWebSocket.lastInstance!.url).toBe(
      'wss://stream.binance.com:9443/stream?streams=btcusdt@ticker'
    );
  });

  it('isConnected reflects WebSocket state', async () => {
    const { useBinanceTicker } = await importModule();
    const { result } = renderHook(() => useBinanceTicker(['BTCUSDT']));

    expect(result.current.isConnected).toBe(false);

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    expect(result.current.isConnected).toBe(true);
  });
});

describe('useBinanceKline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.resetMock();
    vi.stubEnv('NEXT_PUBLIC_BINANCE_WS_URL', 'wss://test-ws.example.com');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function importModule() {
    const mod = await import('./useBinanceStream');
    return mod;
  }

  it('builds correct kline stream URL', async () => {
    const { useBinanceKline } = await importModule();
    renderHook(() => useBinanceKline('BTCUSDT', '1h'));

    expect(MockWebSocket.lastInstance!.url).toBe(
      'wss://test-ws.example.com/ws/btcusdt@kline_1h'
    );
  });

  it('no connection when symbol is null', async () => {
    const { useBinanceKline } = await importModule();
    const { result } = renderHook(() => useBinanceKline(null, '1h'));

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.latestCandle).toBeNull();
  });

  it('transforms kline message to OHLCV', async () => {
    const { useBinanceKline } = await importModule();
    const { result } = renderHook(() => useBinanceKline('BTCUSDT', '1h'));

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateMessage({
        e: 'kline',
        s: 'BTCUSDT',
        k: {
          t: 1700000000000,
          o: '40000.50',
          h: '41000.75',
          l: '39500.25',
          c: '40500.00',
          v: '1234.567',
          x: false,
        },
      });
    });

    const candle = result.current.latestCandle!;
    expect(candle.timestamp).toBe(1700000000000);
    expect(candle.open).toBe(40000.5);
    expect(candle.high).toBe(41000.75);
    expect(candle.low).toBe(39500.25);
    expect(candle.close).toBe(40500.0);
    expect(candle.volume).toBe(1234.567);
    expect(result.current.isClosed).toBe(false);
  });

  it('tracks isClosed from kline x field', async () => {
    const { useBinanceKline } = await importModule();
    const { result } = renderHook(() => useBinanceKline('BTCUSDT', '1h'));

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateMessage({
        e: 'kline', s: 'BTCUSDT',
        k: { t: 1700000000000, o: '40000', h: '41000', l: '39500', c: '40500', v: '1000', x: true },
      });
    });

    expect(result.current.isClosed).toBe(true);
  });

  it('isConnected reflects WebSocket state', async () => {
    const { useBinanceKline } = await importModule();
    const { result } = renderHook(() => useBinanceKline('BTCUSDT', '1h'));

    expect(result.current.isConnected).toBe(false);

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
    });

    expect(result.current.isConnected).toBe(true);
  });

  it('reconnects when symbol changes', async () => {
    const { useBinanceKline } = await importModule();
    const { rerender } = renderHook(
      ({ symbol, interval }) => useBinanceKline(symbol, interval),
      { initialProps: { symbol: 'BTCUSDT' as string | null, interval: '1h' } }
    );

    expect(MockWebSocket.lastInstance!.url).toContain('btcusdt@kline_1h');
    const firstCount = MockWebSocket.instances.length;

    rerender({ symbol: 'ETHUSDT', interval: '1h' });

    expect(MockWebSocket.instances.length).toBeGreaterThan(firstCount);
    expect(MockWebSocket.lastInstance!.url).toContain('ethusdt@kline_1h');
  });

  it('reconnects when interval changes', async () => {
    const { useBinanceKline } = await importModule();
    const { rerender } = renderHook(
      ({ symbol, interval }) => useBinanceKline(symbol, interval),
      { initialProps: { symbol: 'BTCUSDT' as string | null, interval: '1h' } }
    );

    expect(MockWebSocket.lastInstance!.url).toContain('kline_1h');
    const firstCount = MockWebSocket.instances.length;

    rerender({ symbol: 'BTCUSDT', interval: '4h' });

    expect(MockWebSocket.instances.length).toBeGreaterThan(firstCount);
    expect(MockWebSocket.lastInstance!.url).toContain('kline_4h');
  });
});
