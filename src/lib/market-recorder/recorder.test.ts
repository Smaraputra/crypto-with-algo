import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aggTradeFrame, forceOrderFrame } from '@/__fixtures__/market-recorder';
import { MockWebSocket } from '@/test/mock-websocket';

import type { LiquidationRecord } from './messages';
import {
  MarketRecorder,
  webSocketFactory,
  type HeartbeatOutcome,
  type RecorderConfig,
  type RecorderGapRecord,
  type RecorderStore,
  type RecorderSymbolSetRecord,
} from './recorder';
import type { SymbolSelection } from './symbols';
import { BUCKET_MS, type TradeFlowBarRecord } from './trade-flow';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const B0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const B1 = B0 + BUCKET_MS;
/** Process start: two minutes before a bucket boundary, so B0 is fully covered. */
const T0 = B0 - 2 * MINUTE;

const WS_BASE = 'wss://test.local/market';

class FakeStore implements RecorderStore {
  liquidations: LiquidationRecord[] = [];
  bars: TradeFlowBarRecord[] = [];
  gaps: RecorderGapRecord[] = [];
  symbolSets: RecorderSymbolSetRecord[] = [];
  heartbeats: HeartbeatOutcome[] = [];
  fail = { bars: false, liquidations: false, meta: false };

  constructor(public healthyAt: number | null = null) {}

  async writeLiquidations(events: readonly LiquidationRecord[]) {
    if (this.fail.liquidations) throw new Error('mongo down');
    this.liquidations.push(...events);
    return events.length;
  }
  async writeTradeFlowBars(bars: readonly TradeFlowBarRecord[]) {
    if (this.fail.bars) throw new Error('mongo down');
    this.bars.push(...bars);
    return bars.length;
  }
  async writeGap(gap: RecorderGapRecord) {
    if (this.fail.meta) throw new Error('mongo down');
    this.gaps.push({ ...gap });
  }
  async closeOpenGaps(end: number) {
    if (this.fail.meta) throw new Error('mongo down');
    let closed = 0;
    for (const gap of this.gaps) {
      if (gap.end === null) {
        gap.end = end;
        closed++;
      }
    }
    return closed;
  }
  async lastHealthyAt() {
    return this.healthyAt;
  }
  async writeSymbolSet(set: RecorderSymbolSetRecord) {
    if (this.fail.meta) throw new Error('mongo down');
    this.symbolSets.push(set);
  }
  async heartbeat(outcome: HeartbeatOutcome) {
    this.heartbeats.push(outcome);
  }
}

function selection(symbols: string[]): SymbolSelection {
  return {
    symbols: symbols.map((symbol, i) => ({ symbol, quoteVolume: 1_000_000 - i })),
    eligibleCount: symbols.length + 10,
    topN: symbols.length,
  };
}

interface Harness {
  recorder: MarketRecorder;
  store: FakeStore;
  /** The events logged so far, read at call time. */
  events: () => string[];
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
}

async function startRecorder(
  options: {
    config?: Partial<RecorderConfig>;
    fetchUniverse?: () => Promise<SymbolSelection>;
    healthyAt?: number | null;
    random?: () => number;
  } = {}
): Promise<Harness> {
  const store = new FakeStore(options.healthyAt ?? null);
  const logs: Harness['logs'] = [];
  const recorder = new MarketRecorder({
    socketFactory: webSocketFactory(MockWebSocket),
    store,
    fetchUniverse: options.fetchUniverse ?? (async () => selection(['BTCUSDT', 'ETHUSDT'])),
    wsBaseUrl: WS_BASE,
    random: options.random ?? (() => 0),
    log: (event, fields) => logs.push({ event, fields }),
    // Most tests send no steady stream, so the stale watchdog is pushed out
    // of the way; its own test restores it.
    config: { staleAfterMs: 1_000 * HOUR, ...options.config },
  });
  await recorder.start();
  return { recorder, store, logs, events: () => logs.map((l) => l.event) };
}

function socket(index = -1): MockWebSocket {
  const list = MockWebSocket.instances;
  return list[index < 0 ? list.length + index : index];
}

/** Lets queued promise work (flushes triggered by a handler) finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  MockWebSocket.resetMock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MarketRecorder: subscription', () => {
  it('opens one combined stream with the liquidation stream and every selected symbol', async () => {
    await startRecorder();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket().url).toBe(`${WS_BASE}/stream?streams=!forceOrder@arr/btcusdt@aggTrade/ethusdt@aggTrade`);
    // Subscribed by URL only: nothing is ever sent on the socket.
    socket().simulateOpen();
    expect(socket().sentMessages).toEqual([]);
  });

  it('records the symbol set it chose at start', async () => {
    const { store } = await startRecorder();
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    expect(store.symbolSets).toHaveLength(1);
    expect(store.symbolSets[0]).toMatchObject({ refreshedAt: T0, topN: 2, eligibleCount: 12, changed: true });
    expect(store.symbolSets[0].symbols.map((s) => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});

describe('MarketRecorder: data path', () => {
  it('folds trades into a bar and writes it once the bucket has closed and the grace passed', async () => {
    const { store } = await startRecorder();
    socket().simulateOpen();

    socket().simulateMessage(aggTradeFrame({ aggId: 1, price: 100, qty: 2, tradeTime: B0 + 1_000, buyerIsMaker: false }));
    socket().simulateMessage(aggTradeFrame({ aggId: 2, price: 101, qty: 1, tradeTime: B0 + 2_000, buyerIsMaker: true }));

    // B0 closes at B1; it is drained at the first bar flush at or after B1 + 30 s.
    await vi.advanceTimersByTimeAsync(B1 + 29 * SECOND - T0);
    expect(store.bars).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(MINUTE + 2 * SECOND);

    expect(store.bars).toHaveLength(1);
    expect(store.bars[0]).toMatchObject({
      symbol: 'BTCUSDT',
      bucketStart: B0,
      buyBase: 2,
      sellBase: 1,
      buyQuote: 200,
      sellQuote: 101,
      firstPrice: 100,
      lastPrice: 101,
      complete: true,
    });
  });

  it('writes each liquidation within the fast flush', async () => {
    const { store } = await startRecorder();
    socket().simulateOpen();

    socket().simulateMessage(forceOrderFrame({ symbol: 'SOLUSDT', side: 'BUY', tradeTime: T0 + 10 }));
    expect(store.liquidations).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    expect(store.liquidations).toHaveLength(1);
    expect(store.liquidations[0]).toMatchObject({ symbol: 'SOLUSDT', side: 'BUY', receivedAt: T0 });
  });

  it('writes early once a batch of liquidations is waiting', async () => {
    const { store } = await startRecorder({ config: { liquidationBatch: 3 } });
    socket().simulateOpen();

    for (let i = 0; i < 3; i++) socket().simulateMessage(forceOrderFrame({ tradeTime: T0 + i }));
    await settle();

    expect(store.liquidations).toHaveLength(3);
  });

  it('counts an invalid frame in the heartbeat and keeps going', async () => {
    const { store, events } = await startRecorder();
    socket().simulateOpen();

    socket().simulateMessage('{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","p":"x"}}');
    socket().simulateMessage(forceOrderFrame({ tradeTime: T0 }));
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(events()).toContain('invalid-message');
    expect(store.liquidations).toHaveLength(1);
    const result = store.heartbeats[0].result as { interval: { invalid: number; liquidations: number } };
    expect(result.interval.invalid).toBe(1);
    expect(result.interval.liquidations).toBe(1);
  });
});

describe('MarketRecorder: gaps and reconnects', () => {
  it('writes the first gap of a process from its start to the first open', async () => {
    const { store } = await startRecorder();
    await vi.advanceTimersByTimeAsync(400);
    socket().simulateOpen();
    await settle();

    expect(store.gaps).toEqual([{ start: T0, end: T0 + 400, reason: 'process-start' }]);
  });

  it('starts the first gap at the previous process last healthy heartbeat after a crash', async () => {
    const crashedAround = T0 - 10 * MINUTE;
    const { store } = await startRecorder({ healthyAt: crashedAround });
    socket().simulateOpen();
    await settle();

    expect(store.gaps).toEqual([{ start: crashedAround, end: T0, reason: 'process-start' }]);
  });

  it('closes the previous process open shutdown row instead of writing its own', async () => {
    const store0 = new FakeStore();
    store0.gaps.push({ start: T0 - MINUTE, end: null, reason: 'shutdown (SIGTERM)' });
    const recorder = new MarketRecorder({
      socketFactory: webSocketFactory(MockWebSocket),
      store: store0,
      fetchUniverse: async () => selection(['BTCUSDT']),
      wsBaseUrl: WS_BASE,
      log: () => {},
    });
    await recorder.start();
    await vi.advanceTimersByTimeAsync(300);
    socket().simulateOpen();
    await settle();

    expect(store0.gaps).toEqual([{ start: T0 - MINUTE, end: T0 + 300, reason: 'shutdown (SIGTERM)' }]);
  });

  it('starts a gap at the last message on an unplanned close and closes it on reconnect', async () => {
    const { store } = await startRecorder();
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    socket().simulateMessage(aggTradeFrame({ aggId: 1, price: 1, qty: 1, tradeTime: T0, buyerIsMaker: false }));
    const lastMessageAt = Date.now();
    await vi.advanceTimersByTimeAsync(3 * SECOND);

    socket().simulateClose(1006, 'abnormal');
    // random() = 0: the first retry waits half the 1 s base.
    await vi.advanceTimersByTimeAsync(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(200);
    socket().simulateOpen();
    await settle();

    expect(store.gaps).toHaveLength(2);
    expect(store.gaps[1]).toEqual({ start: lastMessageAt, end: Date.now(), reason: 'closed 1006: abnormal' });
  });

  it('backs off exponentially, capped, while every attempt fails', async () => {
    await startRecorder({ random: () => 1 });
    socket().simulateOpen();
    socket().simulateClose(1006, '');

    const gaps: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const before = MockWebSocket.instances.length;
      let waited = 0;
      while (MockWebSocket.instances.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      gaps.push(waited);
      socket().simulateClose(1006, '');
    }

    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('resets the backoff only after a connection has stayed up for a minute', async () => {
    await startRecorder({ random: () => 1 });
    socket().simulateOpen();
    socket().simulateClose(1006, ''); // attempt 0: 1 s
    await vi.advanceTimersByTimeAsync(1_000);
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    socket().simulateClose(1006, ''); // short-lived: attempt 1, 2 s

    await vi.advanceTimersByTimeAsync(1_999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(MINUTE);
    socket().simulateClose(1006, ''); // stable: back to 1 s

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('gives up on a connection that never opens and retries', async () => {
    const { store } = await startRecorder();
    const first = socket();

    await vi.advanceTimersByTimeAsync(15 * SECOND);
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(2);

    socket().simulateOpen();
    await settle();
    // Never connected until now, so it is still the process-start gap.
    expect(store.gaps).toEqual([{ start: T0, end: T0 + 15_500, reason: 'process-start' }]);
  });

  it('drops a connection that goes silent and dates the gap from its last message', async () => {
    const { store } = await startRecorder({ config: { staleAfterMs: MINUTE } });
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    socket().simulateMessage(aggTradeFrame({ aggId: 1, price: 1, qty: 1, tradeTime: T0, buyerIsMaker: true }));
    const lastMessageAt = Date.now();
    const stale = socket();

    // The watchdog ticks every 10 s and fires once silence exceeds 60 s.
    await vi.advanceTimersByTimeAsync(70 * SECOND);
    expect(stale.readyState).toBe(MockWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(500);
    socket().simulateOpen();
    await settle();

    expect(store.gaps[1].start).toBe(lastMessageAt);
    expect(store.gaps[1].reason).toMatch(/^stale: no message for \d+ s$/);
  });

  it('marks the bar a disconnect cut through incomplete', async () => {
    const { store } = await startRecorder();
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(B0 + 30 * SECOND - T0);
    socket().simulateMessage(aggTradeFrame({ aggId: 1, price: 1, qty: 1, tradeTime: B0 + 29 * SECOND, buyerIsMaker: false }));
    socket().simulateClose(1006, '');
    await vi.advanceTimersByTimeAsync(500);
    socket().simulateOpen();
    socket().simulateMessage(aggTradeFrame({ aggId: 2, price: 1, qty: 1, tradeTime: B0 + 31 * SECOND, buyerIsMaker: false }));
    socket().simulateMessage(aggTradeFrame({ aggId: 3, price: 1, qty: 1, tradeTime: B1 + SECOND, buyerIsMaker: false }));

    // B1 drains at the first bar flush at or after B1 + 30 s.
    await vi.advanceTimersByTimeAsync(BUCKET_MS * 2 + MINUTE);

    const bars = store.bars.filter((b) => b.symbol === 'BTCUSDT');
    expect(bars.map((b) => [b.bucketStart, b.complete, b.aggTrades])).toEqual([
      [B0, false, 2],
      [B1, true, 1],
    ]);
  });
});

describe('MarketRecorder: planned reconnect and symbol refresh', () => {
  it('swaps connections make-before-break 23 hours in, with no gap and no double count', async () => {
    const { store } = await startRecorder();
    const old = socket();
    old.simulateOpen();
    await settle();
    const gapsBefore = store.gaps.length;

    await vi.advanceTimersByTimeAsync(23 * HOUR);
    expect(MockWebSocket.instances).toHaveLength(2);
    const replacement = socket();
    expect(replacement.url).toBe(old.url);
    expect(old.readyState).toBe(MockWebSocket.OPEN);
    replacement.simulateOpen();

    // The same trades arrive on both during the overlap, in different orders.
    const t = Date.now();
    const frames = [1, 2, 3].map((aggId) =>
      aggTradeFrame({ aggId: 900 + aggId, price: 10, qty: 1, tradeTime: t, buyerIsMaker: false })
    );
    old.simulateMessage(frames[0]);
    old.simulateMessage(frames[1]);
    replacement.simulateMessage(frames[1]);
    replacement.simulateMessage(frames[0]);
    replacement.simulateMessage(frames[2]);
    old.simulateMessage(frames[2]);

    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(old.readyState).toBe(MockWebSocket.CLOSED);
    expect(replacement.readyState).toBe(MockWebSocket.OPEN);

    await vi.advanceTimersByTimeAsync(BUCKET_MS + MINUTE * 2);
    const bar = store.bars.find((b) => b.symbol === 'BTCUSDT' && b.firstAggId === 901);
    expect(bar).toMatchObject({ aggTrades: 3, buyBase: 3, complete: true });
    expect(store.gaps).toHaveLength(gapsBefore);
  });

  it('keeps serving on the old connection when the replacement fails, and retries the swap', async () => {
    const { store } = await startRecorder();
    const old = socket();
    old.simulateOpen();
    await settle();

    await vi.advanceTimersByTimeAsync(23 * HOUR);
    socket().simulateClose(1006, 'refused');
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(old.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(MockWebSocket.instances).toHaveLength(3);
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    expect(old.readyState).toBe(MockWebSocket.CLOSED);
    expect(store.gaps).toHaveLength(1); // only the process-start row
  });

  it('refreshes the ranking every 24 hours and swaps only when the set changed', async () => {
    const universe = vi
      .fn<() => Promise<SymbolSelection>>()
      .mockResolvedValueOnce(selection(['BTCUSDT', 'ETHUSDT']))
      .mockResolvedValueOnce(selection(['ETHUSDT', 'BTCUSDT']))
      .mockResolvedValueOnce(selection(['BTCUSDT', 'SOLUSDT']));
    const { store } = await startRecorder({
      fetchUniverse: universe,
      config: { plannedReconnectMs: 100 * HOUR },
    });
    socket().simulateOpen();

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(universe).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(store.symbolSets.map((s) => s.changed)).toEqual([true, false]);

    // ETHUSDT has an open bar when the set drops it.
    await vi.advanceTimersByTimeAsync(24 * HOUR - 10 * SECOND);
    const ethTradeTime = Date.now();
    const ethBucket = ethTradeTime - (ethTradeTime % BUCKET_MS);
    socket().simulateMessage(
      aggTradeFrame({ symbol: 'ETHUSDT', aggId: 5, price: 1, qty: 1, tradeTime: ethTradeTime, buyerIsMaker: true })
    );
    await vi.advanceTimersByTimeAsync(10 * SECOND);

    expect(universe).toHaveBeenCalledTimes(3);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket().url).toBe(`${WS_BASE}/stream?streams=!forceOrder@arr/btcusdt@aggTrade/solusdt@aggTrade`);
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(socket(0).readyState).toBe(MockWebSocket.CLOSED);
    // One row per refresh, written by the next fast flush.
    expect(store.symbolSets.map((s) => s.changed)).toEqual([true, false, true]);

    await vi.advanceTimersByTimeAsync(2 * BUCKET_MS);
    const eth = store.bars.filter((b) => b.symbol === 'ETHUSDT');
    expect(eth).toHaveLength(1);
    expect(eth[0].bucketStart).toBe(ethBucket);
    expect(eth[0].complete).toBe(false);
  });

  it('records liquidations alone when the ranking fails at start, and retries it', async () => {
    const universe = vi
      .fn<() => Promise<SymbolSelection>>()
      .mockRejectedValueOnce(new Error('HTTP 418'))
      .mockResolvedValueOnce(selection(['BTCUSDT']));
    const { store } = await startRecorder({ fetchUniverse: universe });

    expect(socket().url).toBe(`${WS_BASE}/stream?streams=!forceOrder@arr`);
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(store.heartbeats[0]).toMatchObject({ ok: false, error: expect.stringMatching(/no symbols/) });

    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(universe).toHaveBeenCalledTimes(2);
    expect(socket().url).toBe(`${WS_BASE}/stream?streams=!forceOrder@arr/btcusdt@aggTrade`);
  });
});

describe('MarketRecorder: heartbeat and writes', () => {
  it('heartbeats every minute, healthy while connected', async () => {
    const { store } = await startRecorder();
    socket().simulateOpen();

    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    expect(store.heartbeats).toHaveLength(3);
    expect(store.heartbeats.every((h) => h.ok)).toBe(true);
    expect(store.heartbeats[0].durationMs).toBe(MINUTE);
    expect(store.heartbeats[0].result).toMatchObject({ connected: true, symbols: 2 });
  });

  it('reports failure once disconnected for 90 seconds, and recovers', async () => {
    const { store } = await startRecorder({ config: { backoff: { baseMs: 200_000, maxMs: 200_000 } } });
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    socket().simulateClose(1006, 'abnormal');

    await vi.advanceTimersByTimeAsync(30 * SECOND); // 30 s down: still ok
    expect(store.heartbeats.at(-1)?.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(MINUTE); // 90 s down
    expect(store.heartbeats.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/not connected for 90 s/) });

    await vi.advanceTimersByTimeAsync(10 * SECOND); // the 100 s reconnect fires
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(store.heartbeats.at(-1)?.ok).toBe(true);
  });

  it('keeps rows from a failed write and writes them on the next tick', async () => {
    const { store } = await startRecorder();
    socket().simulateOpen();
    store.fail.liquidations = true;
    socket().simulateMessage(forceOrderFrame({ tradeTime: T0 }));
    socket().simulateMessage(forceOrderFrame({ tradeTime: T0 + 1 }));

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(store.liquidations).toHaveLength(0);
    expect(store.heartbeats.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/liquidations: mongo down/) });

    store.fail.liquidations = false;
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(store.liquidations.map((l) => l.tradeTime)).toEqual([T0, T0 + 1]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(store.heartbeats.at(-1)?.ok).toBe(true);
  });

  it('caps the liquidation buffer during an outage, dropping the oldest', async () => {
    const { store } = await startRecorder({ config: { maxPendingLiquidations: 3 } });
    socket().simulateOpen();
    store.fail.liquidations = true;
    for (let i = 0; i < 5; i++) socket().simulateMessage(forceOrderFrame({ tradeTime: T0 + i }));

    await vi.advanceTimersByTimeAsync(MINUTE);
    const result = store.heartbeats.at(-1)!.result as { pending: { liquidations: number }; interval: { droppedLiquidations: number } };
    expect(result.pending.liquidations).toBe(3);
    expect(result.interval.droppedLiquidations).toBe(2);

    store.fail.liquidations = false;
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(store.liquidations.map((l) => l.tradeTime)).toEqual([T0 + 2, T0 + 3, T0 + 4]);
  });
});

describe('MarketRecorder: graceful stop', () => {
  it('flushes every open bar, marks the last incomplete and leaves an open shutdown gap', async () => {
    const { recorder, store, events } = await startRecorder();
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(B1 + 10 * SECOND - T0);
    socket().simulateMessage(aggTradeFrame({ aggId: 1, price: 1, qty: 1, tradeTime: B0 + 5 * SECOND, buyerIsMaker: false }));
    socket().simulateMessage(aggTradeFrame({ aggId: 2, price: 1, qty: 1, tradeTime: B1 + 5 * SECOND, buyerIsMaker: false }));
    socket().simulateMessage(forceOrderFrame({ tradeTime: B1 + 6 * SECOND }));
    const ws = socket();

    await recorder.stop('SIGTERM');

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    // B0 closed before the stop and stays complete; B1 was cut off.
    expect(store.bars.map((b) => [b.bucketStart, b.complete])).toEqual([
      [B0, true],
      [B1, false],
    ]);
    expect(store.liquidations).toHaveLength(1);
    expect(store.gaps.at(-1)).toEqual({ start: B1 + 10 * SECOND, end: null, reason: 'shutdown (SIGTERM)' });
    expect(events().at(-1)).toBe('stopped');
  });

  it('stops every schedule, so nothing reconnects or heartbeats afterwards', async () => {
    const { recorder, store } = await startRecorder();
    socket().simulateOpen();
    await recorder.stop('SIGINT');
    const heartbeats = store.heartbeats.length;

    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(store.heartbeats).toHaveLength(heartbeats);
  });

  it('carries an open disconnect gap into the shutdown row', async () => {
    const { recorder, store } = await startRecorder({ config: { backoff: { baseMs: 600_000, maxMs: 600_000 } } });
    socket().simulateOpen();
    await vi.advanceTimersByTimeAsync(SECOND);
    socket().simulateClose(1006, 'abnormal');
    const downAt = Date.now() - SECOND; // the last message was the open itself

    await recorder.stop('SIGTERM');

    expect(store.gaps.at(-1)).toEqual({
      start: downAt,
      end: null,
      reason: 'closed 1006: abnormal, then shutdown (SIGTERM)',
    });
  });

  it('is idempotent', async () => {
    const { recorder, store } = await startRecorder();
    socket().simulateOpen();

    await Promise.all([recorder.stop('SIGTERM'), recorder.stop('SIGTERM')]);

    expect(store.gaps.filter((g) => g.end === null)).toHaveLength(1);
  });
});
