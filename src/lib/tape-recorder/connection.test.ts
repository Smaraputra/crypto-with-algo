import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeTapeSockets } from '@/test/fake-tape-socket';

import { ReconnectingConnection, type ClosedGap, type LostInfo } from './connection';

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

function make(config = {}) {
  const sockets = new FakeTapeSockets();
  const frames: string[] = [];
  const lost: LostInfo[] = [];
  const gaps: ClosedGap[] = [];
  let opens = 0;
  const conn = new ReconnectingConnection({
    name: 'test',
    url: 'wss://x.test/s',
    socketFactory: sockets.factory,
    now: () => Date.now(),
    random: () => 0,
    log: () => undefined,
    config,
    onOpen: () => opens++,
    onFrame: (d) => frames.push(d),
    onLost: (i) => lost.push(i),
    onGapClosed: (g) => gaps.push(g),
  });
  return { conn, sockets, frames, lost, gaps, opens: () => opens };
}

describe('ReconnectingConnection', () => {
  it('delivers frames and sends only while open', () => {
    const { conn, sockets, frames } = make();
    conn.start();
    expect(conn.send('early')).toBe(false);
    sockets.last().open();
    expect(conn.connected).toBe(true);
    expect(conn.send('hello')).toBe(true);
    expect(sockets.last().sent).toEqual(['hello']);
    sockets.last().message('frame');
    expect(frames).toEqual(['frame']);
  });

  it('retries with growing backoff and resets the attempt count only after a stable connection', () => {
    const { conn, sockets, lost } = make({ staleAfterMs: 1e9 });
    conn.start();
    sockets.last().serverClose(1006);
    expect(lost).toHaveLength(1);
    // attempt 0: ceiling 1,000, random 0 -> 500 ms.
    vi.advanceTimersByTime(499);
    expect(sockets.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets.sockets).toHaveLength(2);
    sockets.last().serverClose(1006);
    // attempt 1: ceiling 2,000 -> 1,000 ms.
    vi.advanceTimersByTime(999);
    expect(sockets.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets.sockets).toHaveLength(3);
    sockets.last().open();
    vi.advanceTimersByTime(60_000);
    sockets.last().serverClose(1006);
    // Stable for 60 s, so the next retry is back at the floor.
    vi.advanceTimersByTime(500);
    expect(sockets.sockets).toHaveLength(4);
  });

  it('reports one gap per outage, from the last frame to the reopen, with the first reason', () => {
    const { conn, sockets, gaps, lost } = make();
    conn.start();
    sockets.last().open();
    vi.setSystemTime(T0 + 2_000);
    sockets.last().message('x');
    vi.setSystemTime(T0 + 4_000);
    sockets.last().serverClose(1006);
    vi.advanceTimersByTime(500);
    // The retry fails to connect at all.
    vi.advanceTimersByTime(15_000);
    expect(lost.map((l) => l.reason)).toEqual(['disconnect', 'connect-failed']);
    vi.advanceTimersByTime(20_000);
    vi.setSystemTime(T0 + 60_000);
    sockets.last().open();
    expect(gaps).toEqual([{ reason: 'disconnect', from: T0 + 2_000, to: T0 + 60_000 }]);
  });

  it('closes a connection that stays quiet past the stale limit', () => {
    const { conn, sockets, lost } = make({ staleAfterMs: 30_000 });
    conn.start();
    const s = sockets.last();
    s.open();
    vi.advanceTimersByTime(29_000);
    expect(s.closed).toBe(false);
    s.message('alive');
    vi.advanceTimersByTime(29_000);
    expect(s.closed).toBe(false);
    vi.advanceTimersByTime(7_000);
    expect(s.closed).toBe(true);
    expect(lost[0].reason).toBe('stale');
  });

  it('gives up on a connect that never opens', () => {
    const { conn, sockets, lost } = make();
    conn.start();
    vi.advanceTimersByTime(15_000);
    expect(sockets.last().closed).toBe(true);
    expect(lost[0].reason).toBe('connect-failed');
    expect(conn.connected).toBe(false);
  });

  it('sends the keepalive on its interval', () => {
    const { conn, sockets } = make({ keepaliveEveryMs: 10_000, keepaliveMessage: 'ping' });
    conn.start();
    sockets.last().open();
    vi.advanceTimersByTime(25_000);
    sockets.last().message('pong');
    expect(sockets.last().sent).toEqual(['ping', 'ping']);
  });

  it('ignores a late event from a socket it already dropped', () => {
    const { conn, sockets, frames, lost } = make();
    conn.start();
    const old = sockets.last();
    old.open();
    old.serverClose(1006);
    old.message('ghost');
    old.serverClose(1006);
    expect(frames).toEqual([]);
    expect(lost).toHaveLength(1);
    void conn;
  });

  it('stops cleanly and reports an open gap', () => {
    const { conn, sockets } = make();
    conn.start();
    sockets.last().open();
    sockets.last().serverClose(1006);
    const open = conn.stop();
    expect(open).toMatchObject({ reason: 'disconnect' });
    vi.advanceTimersByTime(120_000);
    expect(sockets.sockets).toHaveLength(1);
  });
});
