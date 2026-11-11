// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeTapeSockets, type FakeTapeSocket } from '@/test/fake-tape-socket';

import { TapeRecorder, type TapeRecorderConfig } from './recorder';
import type { GapRow, Heartbeat, TapeMarket } from './types';

const B = Date.UTC(2026, 10, 11, 12, 5, 0);
const S = B - 3_000;
const MARKETS: TapeMarket[] = [
  { coin: 'BTC', lighterMarketId: 1, binanceSymbol: 'BTCUSDT' },
  { coin: 'NVDA', lighterMarketId: 123, binanceSymbol: null },
];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-rec-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(S);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const hourFile = (name: string) => path.join(dir, '2026-11-11', `${name}-12.jsonl.gz`);

function rows(name: string): Array<Record<string, unknown>> {
  return zlib
    .gunzipSync(fs.readFileSync(hourFile(name)))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function gapLines(): GapRow[] {
  const file = path.join(dir, 'gaps.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GapRow);
}

/** Lets real file I/O finish while the fake clock stands still. */
async function io(until: () => boolean = () => false): Promise<void> {
  const end = performance.now() + 2_000;
  for (;;) {
    await new Promise((r) => setImmediate(r));
    if (until() || performance.now() > end) return;
  }
}

function book(id: number, beginNonce: number, nonce: number, ask: number, bid: number, type = 'update', ts = Date.now()) {
  return {
    channel: `order_book:${id}`,
    last_updated_at: ts * 1000,
    timestamp: ts,
    type: `${type}/order_book`,
    order_book: {
      code: 0,
      asks: [{ price: ask.toFixed(1), size: '5.00000' }],
      bids: [{ price: bid.toFixed(1), size: '5.00000' }],
      offset: nonce,
      nonce,
      last_updated_at: ts * 1000,
      begin_nonce: beginNonce,
    },
  };
}

function depth(ask: number, bid: number) {
  return {
    stream: 'btcusdt@depth5@100ms',
    data: {
      e: 'depthUpdate',
      E: Date.now(),
      T: Date.now(),
      s: 'BTCUSDT',
      b: [[bid.toFixed(2), '10']],
      a: [[ask.toFixed(2), '10']],
    },
  };
}

function print(id: number, tradeId: number) {
  return {
    channel: `trade:${id}`,
    liquidation_trades: [],
    nonce: 1,
    type: 'update/trade',
    trades: [
      { trade_id: tradeId, type: 'trade', size: '0.5', price: '100.0', usd_amount: '50.0', is_maker_ask: true, timestamp: Date.now() },
    ],
  };
}

async function startRecorder(config: Partial<TapeRecorderConfig> = {}, statfs?: () => Promise<{ bavail: number; bsize: number }>) {
  const sockets = new FakeTapeSockets();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const recorder = new TapeRecorder({
    markets: MARKETS,
    dir,
    socketFactory: sockets.factory,
    lighterUrl: 'wss://lighter.test/stream',
    binanceUrl: 'wss://binance.test/public',
    random: () => 0,
    log: (event, fields) => logs.push({ event, fields }),
    // The real disk's free space is not what these tests are about.
    config: { ...config, sink: { minFreeBytes: 0, ...config.sink } },
    statfs,
  });
  await recorder.start();
  const lighter = sockets.byUrl('lighter.test')[0];
  const binance = sockets.byUrl('binance.test')[0];
  return { recorder, sockets, lighter, binance, logs };
}

describe('TapeRecorder', () => {
  it('records 1 s rows, burst rows around the 5-minute boundary, prints, and closes the files on stop', async () => {
    const { recorder, lighter, binance } = await startRecorder();
    expect(lighter.url).toBe('wss://lighter.test/stream');
    expect(binance.url).toBe('wss://binance.test/public/stream?streams=btcusdt@depth5@100ms');
    lighter.open();
    lighter.message(book(1, 0, 100, 101, 100, 'subscribed'));
    vi.advanceTimersByTime(1_000);
    // Binance opens late: its rows before the first depth frame say ok:false.
    binance.open();
    vi.advanceTimersByTime(2_500);
    lighter.message(print(1, 1));
    binance.message(depth(101.5, 100.5));
    vi.advanceTimersByTime(3_500);
    expect(Date.now()).toBe(S + 7_000);

    await recorder.stop('SIGTERM');

    const oneSecond = rows('lighter-1s');
    expect(oneSecond.map((r) => r.t)).toEqual(
      [-2, -1, 0, 1, 2, 3, 4].flatMap((s) => [B + s * 1_000, B + s * 1_000])
    );
    const btcFirst = oneSecond[0];
    expect(btcFirst).toMatchObject({ coin: 'BTC', ok: true, bid: 100, ask: 101, bidSz: 5, askSz: 5 });
    expect(oneSecond[1]).toMatchObject({ coin: 'NVDA', ok: false, bid: null, ask: null, rt100: null });

    const burst = rows('lighter-burst');
    expect(burst).toHaveLength(41 * 2);
    expect(burst[0]).toMatchObject({ t: B - 1_000, g: B });
    expect(burst[burst.length - 1]).toMatchObject({ t: B + 3_000, g: B });

    const bBurst = rows('binance-burst');
    expect(bBurst).toHaveLength(41);
    expect(bBurst[0]).toMatchObject({ coin: 'BTC', ok: false, bid: null });
    expect(bBurst[bBurst.length - 1]).toMatchObject({ coin: 'BTC', ok: true, bid: 100.5, ask: 101.5 });
    expect(rows('binance-1s').map((r) => r.ok)).toEqual([false, false, false, true, true, true, true]);

    expect(rows('lighter-trades')).toEqual([
      { t: B + 500, recv: B + 500, coin: 'BTC', px: 100, sz: 0.5, usd: 50, buy: true, type: 'trade' },
    ]);

    const beat = JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'), 'utf8')) as Heartbeat;
    expect(beat).toMatchObject({ markets: 2, stopped: true, droppedRows: 0 });
    expect(fs.readdirSync(path.join(dir, '2026-11-11')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(lighter.closed).toBe(true);
    expect(binance.closed).toBe(true);
  });

  it('writes the heartbeat every minute with the row count and the last gap', async () => {
    const { recorder, lighter } = await startRecorder();
    lighter.open();
    lighter.message(book(1, 0, 100, 101, 100, 'subscribed'));
    // Keep the connection alive for a minute.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      lighter.message({ type: 'pong' });
    }
    const hb = path.join(dir, 'heartbeat.json');
    const readBeat = () => {
      try {
        return JSON.parse(fs.readFileSync(hb, 'utf8')) as Heartbeat;
      } catch {
        return null;
      }
    };
    await io(() => readBeat()?.t === S + 60_000);
    const beat = JSON.parse(fs.readFileSync(hb, 'utf8')) as Heartbeat;
    expect(beat.t).toBe(S + 60_000);
    expect(beat.lighterConnected).toBe(true);
    expect(beat.binanceConnected).toBe(false);
    // 60 s of 1 s rows for two Lighter coins, minus the rows of the sampler's first partial second.
    expect(beat.rowsLastMinute).toBeGreaterThanOrEqual(118);
    expect(beat.stopped).toBe(false);
    await recorder.stop('SIGTERM');
  });

  it('writes a process-start gap from the previous heartbeat', async () => {
    fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({ t: S - 90_000, stopped: false }));
    const { recorder } = await startRecorder();
    await recorder.stop('SIGTERM');
    expect(gapLines()).toEqual([{ t: S, venue: 'tape', coin: null, reason: 'process-start', from: S - 90_000, to: S }]);
  });

  it('records a Lighter outage: rows go ok:false, then gaps for the connection and the market', async () => {
    const { recorder, lighter, sockets } = await startRecorder();
    lighter.open();
    lighter.message(book(1, 0, 100, 101, 100, 'subscribed'));
    vi.advanceTimersByTime(2_000);
    lighter.message(book(1, 100, 110, 101, 100, 'update'));
    const lastFrame = Date.now();

    vi.advanceTimersByTime(500);
    lighter.serverClose(1006);
    vi.advanceTimersByTime(1_500);
    // Reconnected (backoff 500 ms), but no snapshot yet.
    const next = sockets.byUrl('lighter.test')[1] as FakeTapeSocket;
    expect(next).toBeDefined();
    next.open();
    vi.advanceTimersByTime(1_000);
    next.message(book(1, 0, 900, 102, 101, 'subscribed'));
    const resumed = Date.now();
    vi.advanceTimersByTime(1_000);

    await recorder.stop('SIGTERM');
    const oneSecond = rows('lighter-1s').filter((r) => r.coin === 'BTC');
    expect(oneSecond.map((r) => r.ok)).toEqual([true, true, false, false, false, true]);
    expect(oneSecond[2]).toMatchObject({ bid: null, ask: null, recv: lastFrame });

    const gaps = gapLines();
    expect(gaps.map((g) => [g.venue, g.coin, g.reason])).toEqual([
      ['lighter', null, 'disconnect'],
      ['lighter', 'BTC', 'resubscribe'],
    ]);
    expect(gaps[0]).toMatchObject({ from: lastFrame, to: S + 4_000 });
    expect(gaps[1]).toMatchObject({ from: lastFrame, to: resumed });
  });

  it('closes spans that are still open at shutdown', async () => {
    const { recorder, lighter } = await startRecorder();
    lighter.open();
    lighter.message(book(1, 0, 100, 101, 100, 'subscribed'));
    vi.advanceTimersByTime(1_000);
    lighter.serverClose(1006);
    vi.advanceTimersByTime(100);
    await recorder.stop('SIGTERM');
    const gaps = gapLines();
    expect(gaps.map((g) => [g.venue, g.coin, g.reason])).toEqual([
      ['lighter', null, 'disconnect'],
      ['lighter', 'BTC', 'resubscribe'],
    ]);
    for (const g of gaps) expect(g.to).toBe(Date.now());
  });

  it('stops writing rows below the disk floor, keeps the feeds up, and says so in the heartbeat', async () => {
    const free = { bytes: 5 * 1024 ** 3 };
    const { recorder, lighter } = await startRecorder(
      { sink: { minFreeBytes: 10 * 1024 ** 3 } },
      async () => ({ bavail: free.bytes, bsize: 1 })
    );
    lighter.open();
    lighter.message(book(1, 0, 100, 101, 100, 'subscribed'));
    vi.advanceTimersByTime(3_000);
    // Feed is alive, quotes are good, nothing is written.
    expect(recorder.lighter.quote('BTC')?.ok).toBe(true);
    expect(recorder.sink.diskFloorActive).toBe(true);
    expect(recorder.sink.accepted).toBe(0);
    expect(recorder.sink.diskDropped).toBeGreaterThan(0);

    vi.advanceTimersByTime(57_000);
    const hb = path.join(dir, 'heartbeat.json');
    const readBeat = () => {
      try {
        return JSON.parse(fs.readFileSync(hb, 'utf8')) as Heartbeat;
      } catch {
        return null;
      }
    };
    await io(() => readBeat()?.t === S + 60_000);
    expect(readBeat()).toMatchObject({ diskFloor: true, freeGb: 5, rowsLastMinute: 0 });

    // Space returns: rows flow again and one disk-floor gap line covers the span.
    free.bytes = 50 * 1024 ** 3;
    // The next check is a minute after the last one.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      lighter.message({ type: 'pong' });
    }
    await io(() => !recorder.sink.diskFloorActive);
    lighter.message({ type: 'pong' });
    vi.advanceTimersByTime(2_000);
    expect(recorder.sink.accepted).toBeGreaterThan(0);
    await recorder.stop('SIGTERM');
    const floorGaps = gapLines().filter((g) => g.reason === 'disk-floor');
    expect(floorGaps).toHaveLength(1);
    expect(floorGaps[0]).toMatchObject({ venue: 'tape', coin: null });
  });

  it('stop is idempotent', async () => {
    const { recorder } = await startRecorder();
    const a = recorder.stop('SIGTERM');
    const b = recorder.stop('SIGINT');
    expect(a).toBe(b);
    await a;
  });
});
