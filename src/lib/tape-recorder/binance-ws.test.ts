// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeTapeSockets } from '@/test/fake-tape-socket';

import { BinanceFeed, buildBinanceUrl, parseBinanceFrame } from './binance-ws';
import type { GapReport, TapeMarket } from './types';

const lines = fs
  .readFileSync(path.resolve(__dirname, '../../__fixtures__/tape/binance-public.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { recv: number; raw: string });

const MARKETS: TapeMarket[] = [
  { coin: 'BTC', lighterMarketId: 1, binanceSymbol: 'BTCUSDT' },
  { coin: 'ETH', lighterMarketId: 0, binanceSymbol: 'ETHUSDT' },
  { coin: 'NVDA', lighterMarketId: 123, binanceSymbol: null },
];

const T0 = lines[0].recv;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

function feed() {
  const sockets = new FakeTapeSockets();
  const gaps: GapReport[] = [];
  const f = new BinanceFeed({
    markets: MARKETS,
    baseUrl: 'wss://binance.test/public/',
    socketFactory: sockets.factory,
    now: () => Date.now(),
    random: () => 0,
    log: () => undefined,
    onGap: (g) => gaps.push(g),
  });
  return { f, sockets, gaps };
}

describe('parseBinanceFrame on the captured frames', () => {
  it('parses depth5 frames and ignores bookTicker', () => {
    const parsed = lines.map((l) => parseBinanceFrame(l.raw));
    const depth = parsed.filter((p) => p.kind === 'depth');
    expect(depth).toHaveLength(7);
    expect(parsed.filter((p) => p.kind === 'ignored')).toHaveLength(15);
    expect(parsed.filter((p) => p.kind === 'invalid')).toHaveLength(0);
    expect(depth[0]).toEqual({
      kind: 'depth',
      symbol: 'BTCUSDT',
      exch: 1794376304920,
      bids: [
        [73863.9, 0.445],
        [73863.8, 0.001],
        [73863.7, 0.001],
        [73863.6, 0.002],
        [73863.5, 0.002],
      ],
      asks: [
        [73864.0, 3.637],
        [73864.1, 0.122],
        [73864.2, 0.01],
        [73864.3, 0.028],
        [73864.4, 0.111],
      ],
    });
  });

  it('flags frames it cannot read', () => {
    expect(parseBinanceFrame('nope').kind).toBe('invalid');
    expect(parseBinanceFrame('{"stream":"btcusdt@depth5@100ms","data":{"E":1}}').kind).toBe('invalid');
    expect(parseBinanceFrame('{"result":null,"id":1}').kind).toBe('ignored');
  });
});

describe('buildBinanceUrl', () => {
  it('uses lower-case symbols under the base path', () => {
    expect(buildBinanceUrl('wss://fstream.binance.com/public/', ['BTCUSDT', 'ETHUSDT'])).toBe(
      'wss://fstream.binance.com/public/stream?streams=btcusdt@depth5@100ms/ethusdt@depth5@100ms'
    );
  });
});

describe('BinanceFeed', () => {
  it('connects once for the markets that have a symbol and builds quotes from the frames', () => {
    const { f, sockets, gaps } = feed();
    expect(f.symbolCount).toBe(2);
    f.start();
    expect(sockets.sockets).toHaveLength(1);
    expect(sockets.last().url).toBe('wss://binance.test/public/stream?streams=btcusdt@depth5@100ms/ethusdt@depth5@100ms');
    expect(f.quote('BTC')).toMatchObject({ ok: false, bid: null });
    sockets.last().open();
    for (const l of lines) {
      vi.setSystemTime(l.recv);
      sockets.last().message(l.raw);
    }
    const btc = f.quote('BTC');
    expect(btc?.ok).toBe(true);
    expect(btc?.bid as number).toBeLessThan(btc?.ask as number);
    expect(btc?.rt100).not.toBeNull();
    // Five levels hold well under 20,000 USD on the ask side, so the large size is null.
    expect(f.quote('ETH')?.ok).toBe(true);
    expect(f.quote('NVDA')).toBeNull();
    expect(gaps).toEqual([]);
  });

  it('marks every symbol unsynced on a disconnect and logs the gap when it reconnects', () => {
    const { f, sockets, gaps } = feed();
    f.start();
    const first = sockets.last();
    first.open();
    vi.setSystemTime(T0 + 1_000);
    first.message(lines[0].raw);
    expect(f.quote('BTC')?.ok).toBe(true);

    vi.setSystemTime(T0 + 3_000);
    first.serverClose(1006);
    expect(f.quote('BTC')).toMatchObject({ ok: false, bid: null, ask: null });
    vi.advanceTimersByTime(500);
    expect(sockets.sockets).toHaveLength(2);
    vi.setSystemTime(T0 + 3_600);
    sockets.last().open();
    expect(gaps).toEqual([{ venue: 'binance', coin: null, reason: 'disconnect', from: T0 + 1_000, to: T0 + 3_600 }]);
    expect(f.quote('BTC')?.ok).toBe(false);
    sockets.last().message(lines[0].raw);
    expect(f.quote('BTC')?.ok).toBe(true);
  });

  it('does not connect when no market has a Binance symbol', () => {
    const sockets = new FakeTapeSockets();
    const f = new BinanceFeed({
      markets: [MARKETS[2]],
      socketFactory: sockets.factory,
      now: () => Date.now(),
      log: () => undefined,
      onGap: () => undefined,
    });
    f.start();
    expect(f.enabled).toBe(false);
    expect(sockets.sockets).toHaveLength(0);
  });
});

describe('BinanceFeed per-symbol staleness (I)', () => {
  it('gives a symbol with no frame for 60 s ok:false rows until a frame arrives, without touching the others', () => {
    const { f, sockets } = feed();
    f.start();
    const socket = sockets.last();
    socket.open();
    const btc = lines[0].raw;
    const eth = lines.find((l) => l.raw.includes('ethusdt@depth5@100ms'))?.raw as string;
    socket.message(btc);
    socket.message(eth);
    expect(f.quote('BTC')?.ok).toBe(true);
    // ETH keeps pushing; BTC goes quiet. The connection itself stays healthy.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      socket.message(eth);
    }
    expect(f.quote('BTC')?.ok).toBe(true);
    vi.advanceTimersByTime(10_500);
    socket.message(eth);
    expect(f.quote('BTC')).toMatchObject({ ok: false, bid: null, ask: null, rt100: null });
    expect(f.quote('BTC')?.recv).toBe(T0);
    expect(f.quote('ETH')?.ok).toBe(true);
    expect(sockets.sockets).toHaveLength(1);
    socket.message(btc);
    expect(f.quote('BTC')?.ok).toBe(true);
  });
});
