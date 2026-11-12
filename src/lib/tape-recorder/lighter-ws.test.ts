// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeTapeSockets, type FakeTapeSocket } from '@/test/fake-tape-socket';

import { LighterFeed, parseLighterFrame, type LighterFeedConfig } from './lighter-ws';
import type { GapReport, TapeMarket, TradeRow } from './types';

interface FixtureLine {
  recv: number;
  raw: string;
}

function fixture(name: string): FixtureLine[] {
  const file = path.resolve(__dirname, '../../__fixtures__/tape', name);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FixtureLine);
}

const BTC: TapeMarket = { coin: 'BTC', lighterMarketId: 1, binanceSymbol: 'BTCUSDT' };
const ETH: TapeMarket = { coin: 'ETH', lighterMarketId: 0, binanceSymbol: 'ETHUSDT' };

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

function level(price: number, size: number) {
  return { price: price.toFixed(1), size: size.toFixed(5) };
}

function bookFrame(
  type: 'subscribed' | 'update',
  id: number,
  beginNonce: number,
  nonce: number,
  asks: Array<[number, number]>,
  bids: Array<[number, number]>,
  ts = T0
) {
  return {
    channel: `order_book:${id}`,
    last_updated_at: ts * 1000,
    offset: nonce,
    timestamp: ts,
    type: `${type}/order_book`,
    order_book: {
      code: 0,
      asks: asks.map(([p, s]) => level(p, s)),
      bids: bids.map(([p, s]) => level(p, s)),
      offset: nonce,
      nonce,
      last_updated_at: ts * 1000,
      begin_nonce: beginNonce,
    },
  };
}

function tradeFrame(type: 'subscribed' | 'update', id: number, ts: number[], tradeIds: number[], liquidation: number[] = []) {
  const mk = (tid: number, t: number, kind: string) => ({
    trade_id: tid,
    type: kind,
    market_id: id,
    size: '0.5',
    price: '100.0',
    usd_amount: '50.0',
    is_maker_ask: tid % 2 === 0,
    timestamp: t,
  });
  return {
    channel: `trade:${id}`,
    liquidation_trades: liquidation.map((tid) => mk(tid, ts[0], 'liquidation')),
    nonce: 1,
    trades: tradeIds.map((tid, i) => mk(tid, ts[i], 'trade')),
    type: `${type}/trade`,
  };
}

function lastBookTimestamp(lines: FixtureLine[]): number {
  let ts = 0;
  for (const l of lines) {
    const f = parseLighterFrame(l.raw);
    if (f.kind === 'book') ts = f.timestamp;
  }
  return ts;
}

interface Harness {
  feed: LighterFeed;
  sockets: FakeTapeSockets;
  gaps: GapReport[];
  trades: TradeRow[];
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
}

function harness(markets: TapeMarket[] = [BTC], config: Partial<LighterFeedConfig> = {}): Harness {
  const sockets = new FakeTapeSockets();
  const gaps: GapReport[] = [];
  const trades: TradeRow[] = [];
  const logs: Harness['logs'] = [];
  const feed = new LighterFeed({
    markets,
    url: 'wss://lighter.test/stream',
    socketFactory: sockets.factory,
    now: () => Date.now(),
    random: () => 0,
    log: (event, fields) => logs.push({ event, fields }),
    onTrade: (row) => trades.push(row),
    onGap: (gap) => gaps.push(gap),
    config,
  });
  return { feed, sockets, gaps, trades, logs };
}

/** Starts the feed, opens the socket and lets every queued subscribe go out. */
function openAndSubscribe(h: Harness, markets = 1): FakeTapeSocket {
  h.feed.start();
  const socket = h.sockets.last();
  socket.open();
  vi.advanceTimersByTime(400 * markets * 2 + 100);
  return socket;
}

function sync(h: Harness, socket: FakeTapeSocket, id = 1, nonce = 100, ask = 101, bid = 100): void {
  socket.message(bookFrame('subscribed', id, 0, nonce, [[ask, 5], [ask + 1, 5]], [[bid, 5], [bid - 1, 5]]));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseLighterFrame on the captured BTC frames', () => {
  const lines = fixture('lighter-btc.jsonl');
  const kinds = lines.map((l) => parseLighterFrame(l.raw));

  it('parses the snapshot, the 40 deltas and the print frames', () => {
    const books = kinds.filter((k) => k.kind === 'book');
    expect(books).toHaveLength(41);
    expect(books.filter((k) => k.kind === 'book' && k.snapshot)).toHaveLength(1);
    expect(kinds.filter((k) => k.kind === 'trades')).toHaveLength(13);
    expect(kinds.filter((k) => k.kind === 'connected')).toHaveLength(1);
    expect(kinds.filter((k) => k.kind === 'invalid')).toHaveLength(0);
    // ticker and market_stats are not used.
    expect(kinds.filter((k) => k.kind === 'ignored').length).toBe(lines.length - 41 - 13 - 1);
  });

  it('reads levels, nonces and the ms timestamp', () => {
    const snap = kinds.find((k) => k.kind === 'book' && k.snapshot);
    expect(snap).toMatchObject({ marketId: 1, beginNonce: 0, nonce: 27283353141, timestamp: 1794376210142 });
    if (snap?.kind !== 'book') throw new Error('no snapshot');
    expect(snap.asks[0]).toEqual([73955.4, 0.40706]);
    expect(snap.bids.length).toBe(1589);
    const first = kinds.find((k) => k.kind === 'book' && !k.snapshot);
    expect(first).toMatchObject({ beginNonce: 27283353141, nonce: 27283353215, timestamp: 1794376210189 });
  });

  it('reads prints: price, size, usd, side and type', () => {
    const update = kinds.find(
      (k) => k.kind === 'trades' && !k.snapshot
    );
    if (update?.kind !== 'trades') throw new Error('no print frame');
    expect(update.trades[0]).toMatchObject({ price: 73953.9, size: 0.00015, usd: 11.093085, buy: false, type: 'trade', timestamp: 1794376210323 });
    const snapshot = kinds.find((k) => k.kind === 'trades' && k.snapshot);
    if (snapshot?.kind !== 'trades') throw new Error('no print snapshot');
    expect(snapshot.trades).toHaveLength(100);
    expect(snapshot.trades.some((t) => t.type === 'liquidation')).toBe(true);
  });

  it('classifies the control frames and bad input', () => {
    expect(parseLighterFrame('{"type":"pong"}')).toEqual({ kind: 'pong' });
    expect(parseLighterFrame('{"error":{"code":30003,"message":"Already Subscribed to : order_book:0"}}').kind).toBe('error');
    expect(parseLighterFrame('nope').kind).toBe('invalid');
    expect(parseLighterFrame('[]').kind).toBe('invalid');
    expect(parseLighterFrame('{"type":"update/order_book","channel":"order_book:1"}').kind).toBe('invalid');
    expect(parseLighterFrame('{"type":"update/ticker","channel":"ticker:1"}').kind).toBe('ignored');
  });
});

describe('LighterFeed on the captured BTC session', () => {
  it('rebuilds a sane book, in step with the ticker frames, and records the prints', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    const lines = fixture('lighter-btc.jsonl');

    let compared = 0;
    let exact = 0;
    for (const line of lines) {
      vi.setSystemTime(line.recv);
      socket.message(line.raw);
      const parsed = JSON.parse(line.raw) as { type: string; ticker?: { b: { price: string }; a: { price: string } } };
      const q = h.feed.quote('BTC');
      if (q?.ok) {
        expect(q.bid).not.toBeNull();
        expect(q.bid as number).toBeLessThan(q.ask as number);
      }
      if (parsed.type === 'update/ticker' && q?.ok) {
        const tb = Number(parsed.ticker?.b.price);
        const ta = Number(parsed.ticker?.a.price);
        // The ticker and the book are separate streams a few ms apart: within 2 bp.
        expect(Math.abs((q.bid as number) - tb) / tb).toBeLessThan(2e-4);
        expect(Math.abs((q.ask as number) - ta) / ta).toBeLessThan(2e-4);
        compared++;
        if (q.bid === tb && q.ask === ta) exact++;
      }
    }

    expect(compared).toBeGreaterThanOrEqual(30);
    // The book is batched every 50 ms and the ticker is not, so exact equality is the minority.
    expect(exact).toBeGreaterThanOrEqual(3);
    expect(h.gaps).toEqual([]);
    expect(h.feed.counters.nonceBreaks).toBe(0);
    expect(h.feed.counters.bookUpdates).toBe(40);

    const q = h.feed.quote('BTC');
    expect(q).toMatchObject({ ok: true });
    expect(q?.exch).toBe(lastBookTimestamp(lines));
    expect(q?.rt100).not.toBeNull();
    expect(q?.rt20000).not.toBeNull();

    // The 100 prints in the subscribe snapshot are history. Only the live ones are recorded.
    const live = lines
      .map((l) => parseLighterFrame(l.raw))
      .flatMap((f) => (f.kind === 'trades' && !f.snapshot ? f.trades : []));
    expect(h.trades).toHaveLength(live.length);
    expect(h.trades[0]).toEqual({
      t: 1794376210323,
      recv: expect.any(Number),
      coin: 'BTC',
      px: 73953.9,
      sz: 0.00015,
      usd: 11.093085,
      buy: false,
      type: 'trade',
    });
  });

  it('subscribes to the book and the prints of each market, in order', () => {
    const h = harness([BTC, ETH]);
    const socket = openAndSubscribe(h, 2);
    expect(socket.sentJson()).toEqual([
      { type: 'subscribe', channel: 'order_book/1' },
      { type: 'subscribe', channel: 'trade/1' },
      { type: 'subscribe', channel: 'order_book/0' },
      { type: 'subscribe', channel: 'trade/0' },
    ]);
  });
});

describe('LighterFeed subscriptions and limits', () => {
  it('paces subscribe messages so they stay under the client message limit', () => {
    const markets: TapeMarket[] = Array.from({ length: 5 }, (_, i) => ({ coin: `C${i}`, lighterMarketId: 10 + i, binanceSymbol: null }));
    const h = harness(markets, { msgsPerMinute: 150 });
    h.feed.start();
    const socket = h.sockets.last();
    socket.open();
    expect(socket.sent).toHaveLength(1);
    vi.advanceTimersByTime(399);
    expect(socket.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.sent).toHaveLength(2);
    vi.advanceTimersByTime(400 * 8);
    expect(socket.sent).toHaveLength(10);
  });

  it('pings every 15 s so the server keeps the connection', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    const before = socket.sent.length;
    vi.advanceTimersByTime(15_000);
    expect(socket.sent.slice(before).map((s) => JSON.parse(s))).toContainEqual({ type: 'ping' });
  });

  it('does not treat a pong or a ticker-free quiet minute as a reason to reconnect', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    sync(h, socket);
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(15_000);
      socket.message({ type: 'pong' });
    }
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.feed.quote('BTC')?.ok).toBe(true);
  });

  it('asks again for a snapshot that never arrives', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    const before = socket.sent.length;
    vi.advanceTimersByTime(20_000);
    const resent = socket.sent.slice(before).map((s) => JSON.parse(s) as { type: string; channel: string });
    expect(resent).toContainEqual({ type: 'unsubscribe', channel: 'order_book/1' });
    expect(resent).toContainEqual({ type: 'subscribe', channel: 'order_book/1' });
    expect(h.logs.some((l) => l.event === 'snapshot-timeout')).toBe(true);
  });
});

describe('LighterFeed book continuity', () => {
  it('shows ok:false until the snapshot, then quotes, and removes levels of size zero', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    expect(h.feed.quote('BTC')).toMatchObject({ ok: false, bid: null, ask: null, rt100: null });
    sync(h, socket);
    expect(h.feed.quote('BTC')).toMatchObject({ ok: true, bid: 100, ask: 101, bidSz: 5, askSz: 5 });
    // Remove the best ask and the best bid (size 0.00000).
    socket.message(bookFrame('update', 1, 100, 110, [[101, 0]], [[100, 0]], T0 + 50));
    expect(h.feed.quote('BTC')).toMatchObject({ ok: true, bid: 99, ask: 102, exch: T0 + 50 });
    expect(h.gaps).toEqual([]);
  });

  it('on a nonce break marks the book unsynced, resubscribes it and logs a gap', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    vi.setSystemTime(T0 + 1_000);
    sync(h, socket);
    vi.setSystemTime(T0 + 2_000);
    socket.message(bookFrame('update', 1, 100, 110, [[101, 4]], [], T0 + 2_000));
    const sentBefore = socket.sent.length;

    vi.setSystemTime(T0 + 3_000);
    // begin_nonce 150 does not continue from 110.
    socket.message(bookFrame('update', 1, 150, 160, [[101, 9]], [], T0 + 3_000));
    expect(h.feed.quote('BTC')).toMatchObject({ ok: false, bid: null, ask: null });
    expect(h.feed.counters.nonceBreaks).toBe(1);

    vi.advanceTimersByTime(900);
    const resent = socket.sent.slice(sentBefore).map((s) => JSON.parse(s));
    expect(resent).toEqual([
      { type: 'unsubscribe', channel: 'order_book/1' },
      { type: 'subscribe', channel: 'order_book/1' },
    ]);

    // Deltas that arrive before the new snapshot are ignored.
    socket.message(bookFrame('update', 1, 160, 170, [[101, 1]], [], T0 + 3_100));
    expect(h.feed.quote('BTC')?.ok).toBe(false);
    expect(h.feed.counters.nonceBreaks).toBe(1);

    vi.setSystemTime(T0 + 4_000);
    socket.message(bookFrame('subscribed', 1, 0, 500, [[103, 1]], [[102, 1]], T0 + 4_000));
    expect(h.feed.quote('BTC')).toMatchObject({ ok: true, bid: 102, ask: 103 });
    expect(h.gaps).toEqual([{ venue: 'lighter', coin: 'BTC', reason: 'nonce-break', from: T0 + 2_000, to: T0 + 4_000 }]);
  });

  it('treats a crossed book as corrupt and resubscribes', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    sync(h, socket);
    socket.message(bookFrame('update', 1, 100, 110, [[99, 1]], [], T0 + 10));
    expect(h.feed.quote('BTC')?.ok).toBe(false);
    socket.message(bookFrame('subscribed', 1, 0, 300, [[101, 1]], [[100, 1]], T0 + 20));
    expect(h.gaps.map((g) => g.reason)).toEqual(['crossed-book']);
  });

  it('ignores frames for markets it does not follow', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    socket.message(bookFrame('subscribed', 99, 0, 5, [[1, 1]], [[0.5, 1]]));
    expect(h.feed.quote('BTC')?.ok).toBe(false);
    expect(h.feed.quote('NOPE')).toBeNull();
  });
});

describe('LighterFeed reconnect', () => {
  it('reconnects with backoff, logs the connection gap and each market resubscribe gap', () => {
    const h = harness([BTC, ETH]);
    const socket = openAndSubscribe(h, 2);
    vi.setSystemTime(T0 + 1_000);
    sync(h, socket, 1, 100);
    sync(h, socket, 0, 200, 51, 50);
    vi.setSystemTime(T0 + 5_000);
    socket.message(bookFrame('update', 1, 100, 110, [[101, 4]], [], T0 + 5_000));

    vi.setSystemTime(T0 + 6_000);
    socket.serverClose(1006);
    expect(h.feed.connected).toBe(false);
    expect(h.feed.quote('BTC')).toMatchObject({ ok: false, bid: null, recv: T0 + 5_000 });
    expect(h.sockets.sockets).toHaveLength(1);

    // First retry: backoff 1,000 ms at attempt 0 with random 0 is 500 ms.
    vi.advanceTimersByTime(500);
    expect(h.sockets.sockets).toHaveLength(2);
    const second = h.sockets.last();
    vi.setSystemTime(T0 + 6_600);
    second.open();
    // From the last frame received (the delta at T0 + 5,000) to the reopen.
    expect(h.gaps).toEqual([{ venue: 'lighter', coin: null, reason: 'disconnect', from: T0 + 5_000, to: T0 + 6_600 }]);

    vi.advanceTimersByTime(400 * 4 + 100);
    expect(second.sentJson().filter((m) => m.type === 'subscribe')).toHaveLength(4);

    vi.setSystemTime(T0 + 8_000);
    second.message(bookFrame('subscribed', 1, 0, 900, [[101, 1]], [[100, 1]], T0 + 8_000));
    second.message(bookFrame('subscribed', 0, 0, 800, [[51, 1]], [[50, 1]], T0 + 8_000));
    const marketGaps = h.gaps.filter((g) => g.coin !== null);
    expect(marketGaps).toEqual([
      { venue: 'lighter', coin: 'BTC', reason: 'resubscribe', from: T0 + 5_000, to: T0 + 8_000 },
      { venue: 'lighter', coin: 'ETH', reason: 'resubscribe', from: T0 + 1_000, to: T0 + 8_000 },
    ]);
    expect(h.feed.quote('ETH')?.ok).toBe(true);
  });

  it('reconnects when no frame arrives for 30 s even though pings go out', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    sync(h, socket);
    vi.advanceTimersByTime(36_000);
    expect(socket.closed).toBe(true);
    expect(h.logs.find((l) => l.event === 'connection-lost')?.fields).toMatchObject({ reason: 'stale' });
    expect(h.feed.quote('BTC')?.ok).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(h.sockets.sockets).toHaveLength(2);
    h.sockets.last().open();
    expect(h.gaps[0]).toMatchObject({ venue: 'lighter', coin: null, reason: 'stale' });
  });

  it('after a reconnect, records the prints it missed and none twice', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    sync(h, socket);
    socket.message(tradeFrame('subscribed', 1, [T0 - 5_000, T0 - 4_000], [1, 2]));
    expect(h.trades).toHaveLength(0);
    socket.message(tradeFrame('update', 1, [T0 + 100], [3]));
    socket.message(tradeFrame('update', 1, [T0 + 100], [3]));
    expect(h.trades.map((t) => t.t)).toEqual([T0 + 100]);

    socket.serverClose(1006);
    vi.advanceTimersByTime(600);
    const next = h.sockets.last();
    next.open();
    // The snapshot repeats 2 and 3 and adds 4 and 5, newer than the last print seen.
    next.message(tradeFrame('subscribed', 1, [T0 - 4_000, T0 + 100, T0 + 3_000, T0 + 4_000], [2, 3, 4, 5]));
    expect(h.trades.map((t) => t.t)).toEqual([T0 + 100, T0 + 3_000, T0 + 4_000]);
    expect(h.trades[1]).toMatchObject({ buy: true, coin: 'BTC', px: 100, sz: 0.5, usd: 50 });
  });

  it('records liquidation prints with their type', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    socket.message(tradeFrame('subscribed', 1, [T0], [1]));
    socket.message(tradeFrame('update', 1, [T0 + 10], [2], [9]));
    expect(h.trades.map((t) => t.type).sort()).toEqual(['liquidation', 'trade']);
  });
});

describe('LighterFeed reconnect fill at the same millisecond (H)', () => {
  it('keeps an unseen print that shares the last seen print millisecond, and still drops the seen one', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    sync(h, socket);
    socket.message(tradeFrame('subscribed', 1, [T0 - 5_000], [1]));
    socket.message(tradeFrame('update', 1, [T0 + 100], [3]));
    expect(h.trades.map((t) => t.t)).toEqual([T0 + 100]);

    socket.serverClose(1006);
    vi.advanceTimersByTime(600);
    const next = h.sockets.last();
    next.open();
    // Print 3 was seen. Print 6 happened in the same millisecond and was missed during the outage.
    next.message(tradeFrame('subscribed', 1, [T0 - 5_000, T0 + 100, T0 + 100], [1, 3, 6]));
    expect(h.trades.map((t) => t.t)).toEqual([T0 + 100, T0 + 100]);
    expect(h.trades.map((t) => t.sz)).toEqual([0.5, 0.5]);
    expect(h.feed.counters.duplicateTrades).toBe(2);
  });
});

describe('LighterFeed snapshots and stuck markets (I)', () => {
  it('treats a crossed snapshot as corrupt: stays unsynced and asks again', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    const sent = socket.sent.length;
    socket.message(bookFrame('subscribed', 1, 0, 100, [[99, 1]], [[100, 1]]));
    expect(h.feed.quote('BTC')?.ok).toBe(false);
    expect(h.feed.counters.nonceBreaks).toBe(1);
    vi.advanceTimersByTime(900);
    expect(socket.sent.slice(sent).map((s) => JSON.parse(s))).toEqual([
      { type: 'unsubscribe', channel: 'order_book/1' },
      { type: 'subscribe', channel: 'order_book/1' },
    ]);
    // Deltas on a crossed snapshot are not applied either.
    socket.message(bookFrame('update', 1, 100, 110, [[101, 1]], [], T0 + 5));
    expect(h.feed.quote('BTC')?.ok).toBe(false);
    sync(h, socket);
    expect(h.feed.quote('BTC')).toMatchObject({ ok: true, bid: 100, ask: 101 });
  });

  it('writes a stuck gap line after 60 s without a snapshot, then once an hour', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    const opened = T0;
    const run = (ms: number) => {
      for (let waited = 0; waited < ms; waited += 5_000) {
        vi.advanceTimersByTime(5_000);
        socket.message({ type: 'pong' });
      }
    };
    run(55_000);
    expect(h.gaps).toEqual([]);
    run(10_000);
    expect(h.gaps).toEqual([{ venue: 'lighter', coin: 'BTC', reason: 'stuck', from: opened, to: expect.any(Number) }]);
    expect(h.gaps[0].to - opened).toBeGreaterThanOrEqual(60_000);
    expect(h.gaps[0].to - opened).toBeLessThan(70_000);
    run(3_000_000);
    expect(h.gaps).toHaveLength(1);
    run(700_000);
    expect(h.gaps).toHaveLength(2);
    expect(h.gaps[1]).toMatchObject({ coin: 'BTC', reason: 'stuck', from: opened });
    // Once it syncs the clock stops.
    sync(h, socket);
    run(4_000_000);
    expect(h.gaps).toHaveLength(2);
  });

  it('does not report a market that syncs in time, nor one that is quiet but synced', () => {
    const h = harness();
    const socket = openAndSubscribe(h);
    sync(h, socket);
    for (let i = 0; i < 400; i++) {
      vi.advanceTimersByTime(10_000);
      socket.message({ type: 'pong' });
    }
    expect(h.gaps).toEqual([]);
    expect(h.feed.quote('BTC')?.ok).toBe(true);
  });
});

describe('LighterFeed work per frame and per tick (regression for the CPU report)', () => {
  const N = 28;
  const markets: TapeMarket[] = Array.from({ length: N }, (_, i) => ({ coin: `C${i}`, lighterMarketId: i, binanceSymbol: null }));
  const asks = (n: number) => Array.from({ length: n }, (_, i) => [5000 + i, 1] as [number, number]);
  const bids = (n: number) => Array.from({ length: n }, (_, i) => [4999 - i, 1] as [number, number]);

  it('a delta costs no sort, no walk and no summary, whatever the size of the book', async () => {
    const { Sampler } = await import('./sampler');
    const h = harness(markets, { msgsPerMinute: 190 });
    const socket = openAndSubscribe(h, N);
    const nonce: number[] = [];
    for (let i = 0; i < N; i++) {
      socket.message(bookFrame('subscribed', i, 0, 1_000, asks(2_000), bids(2_000)));
      nonce[i] = 1_000;
    }
    // One sort per side per snapshot, nothing else.
    expect(h.feed.workStats()).toEqual({ sorts: 2 * N, walks: 0, summaries: 0 });
    expect(h.feed.bookLevels()[0]).toEqual({ coin: 'C0', bids: 2_000, asks: 2_000 });

    // 1,400 delta frames (50 per market), each touching 20 levels in a 4,000-level book.
    for (let k = 0; k < 50; k++) {
      for (let i = 0; i < N; i++) {
        const changes = Array.from({ length: 10 }, (_, j) => [5000 + ((k * 10 + j) % 2_000), 1 + (k % 3)] as [number, number]);
        socket.message(bookFrame('update', i, nonce[i], nonce[i] + 10, changes, changes.map(([p, s]) => [9_999 - p, s] as [number, number])));
        nonce[i] += 10;
      }
    }
    expect(h.feed.counters.bookUpdates).toBe(50 * N);
    expect(h.feed.counters.nonceBreaks).toBe(0);
    expect(h.feed.workStats()).toEqual({ sorts: 2 * N, walks: 0, summaries: 0 });
    expect(h.feed.bookLevels()[0]).toEqual({ coin: 'C0', bids: 2_000, asks: 2_000 });

    // Sampler on the fake clock: work happens only on ticks that emit a row.
    let rows = 0;
    const sampler = new Sampler({
      coins: { lighter: markets.map((m) => m.coin), binance: [] },
      source: { quote: (_v, c) => h.feed.quote(c) },
      emit: () => {
        rows++;
      },
      onGap: () => undefined,
    });
    const B = Math.ceil(Date.now() / 300_000) * 300_000 + 300_000;
    sampler.start(B - 60_000);
    let wakeups = 0;
    let now = B - 60_000;
    // 10 s well outside any burst window: one wake-up and one row set per second.
    while (now < B - 50_000) {
      now = sampler.nextDue;
      vi.setSystemTime(now);
      sampler.advance(now);
      wakeups++;
    }
    expect(wakeups).toBe(10);
    expect(rows).toBe(10 * N);
    // The books did not change between those seconds: the first second computed each summary once
    // (4 sizes x 2 sides = 8 walks), the other nine seconds were cache hits.
    expect(h.feed.workStats()).toEqual({ sorts: 2 * N, walks: 8 * N, summaries: N });

    // A changed book is summarised once per row set, not once per row.
    socket.message(bookFrame('update', 0, nonce[0], nonce[0] + 10, [[5000, 5]], []));
    now = sampler.nextDue;
    vi.setSystemTime(now);
    sampler.advance(now);
    expect(h.feed.workStats().summaries).toBe(N + 1);
    expect(h.feed.workStats().sorts).toBe(2 * N);
  });

  it('inside the burst window an unchanged book is not walked again', async () => {
    const { Sampler } = await import('./sampler');
    const h = harness(markets, { msgsPerMinute: 190 });
    const socket = openAndSubscribe(h, N);
    for (let i = 0; i < N; i++) socket.message(bookFrame('subscribed', i, 0, 1_000, asks(500), bids(500)));
    const sampler = new Sampler({
      coins: { lighter: markets.map((m) => m.coin), binance: [] },
      source: { quote: (_v, c) => h.feed.quote(c) },
      emit: () => undefined,
      onGap: () => undefined,
    });
    const B = Math.ceil(Date.now() / 300_000) * 300_000 + 300_000;
    sampler.start(B - 1_100);
    let now = B - 1_100;
    let ticks = 0;
    while (now < B + 3_000) {
      now = sampler.nextDue;
      vi.setSystemTime(now);
      sampler.advance(now);
      ticks++;
    }
    expect(ticks).toBe(41);
    expect(h.feed.workStats()).toEqual({ sorts: 2 * N, walks: 8 * N, summaries: N });
  });
});
