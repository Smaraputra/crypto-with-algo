import { OrderBook } from './book';
import {
  DEFAULT_CONNECTION_CONFIG,
  ReconnectingConnection,
  type ClosedGap,
  type ConnectionConfig,
  type LostInfo,
} from './connection';
import type {
  GapReason,
  GapReport,
  Level,
  LogFn,
  QuoteState,
  TapeMarket,
  TapeSocketFactory,
  TradeRow,
} from './types';

/**
 * Lighter feed: one WebSocket (`/stream?readonly=true`) carrying, per market,
 * `order_book/{id}` (a full snapshot on subscribe, then deltas about every
 * 50 ms) and `trade/{id}`. The ticker, market_stats and account channels are
 * not used: the ticker repeats the book at about 54 frames a second per major
 * market.
 *
 * Frames (checked against src/__fixtures__/tape/lighter-btc.jsonl, 2026-11-11):
 *   {"type":"connected"}                                 on open
 *   {"type":"subscribed/order_book","channel":"order_book:1","order_book":{asks,bids,nonce,begin_nonce:0},"timestamp":ms}
 *   {"type":"update/order_book", ... "order_book":{asks,bids,nonce,begin_nonce}, "timestamp":ms}
 *   {"type":"subscribed/trade"|"update/trade","channel":"trade:1","trades":[...],"liquidation_trades":[...]}
 * A level is {"price":"73955.4","size":"0.40706"}; size "0.00000" removes it.
 * Continuity: an update's `begin_nonce` must equal the previous frame's
 * `nonce`. On a break the market is marked unsynced, its deltas are ignored,
 * and it is unsubscribed and subscribed again for a fresh snapshot.
 *
 * KEEPALIVE. The server closes a connection that sends no frame for 2 minutes
 * (docs.lighter.xyz/api/websocket); a `{"type":"ping"}` is answered by a pong.
 * The feed pings every `keepaliveEveryMs`, which also keeps the stale
 * watchdog meaningful on a quiet connection.
 *
 * LIMITS. At most 200 client messages a minute: subscriptions are paced
 * `ceil(60000 / msgsPerMinute)` ms apart (default 150 a minute), which also
 * spaces out the 1,000 to 2,000 level snapshots.
 */

export const DEFAULT_LIGHTER_WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';

export interface LighterTrade {
  id: number;
  /** Exchange timestamp, ms. */
  timestamp: number;
  price: number;
  size: number;
  usd: number;
  /** True when the taker bought (`is_maker_ask`). */
  buy: boolean;
  type: string;
}

export type LighterFrame =
  | { kind: 'connected' }
  | { kind: 'pong' }
  | {
      kind: 'book';
      snapshot: boolean;
      marketId: number;
      /** Frame timestamp, ms. */
      timestamp: number;
      beginNonce: number;
      nonce: number;
      asks: Level[];
      bids: Level[];
    }
  | { kind: 'trades'; snapshot: boolean; marketId: number; trades: LighterTrade[] }
  | { kind: 'error'; message: string }
  | { kind: 'ignored' }
  | { kind: 'invalid'; reason: string };

function num(value: unknown): number {
  if (typeof value === 'string') return value.length > 0 ? Number(value) : NaN;
  return typeof value === 'number' ? value : NaN;
}

function parseLevels(value: unknown): Level[] | null {
  if (!Array.isArray(value)) return null;
  const out: Level[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const price = num((raw as { price?: unknown }).price);
    const size = num((raw as { size?: unknown }).size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    out.push([price, size]);
  }
  return out;
}

function marketIdOf(channel: unknown): number | null {
  if (typeof channel !== 'string') return null;
  const idx = channel.indexOf(':');
  if (idx < 0) return null;
  const id = Number(channel.slice(idx + 1));
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function parseTrade(raw: unknown): LighterTrade | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const id = num(t.trade_id);
  const timestamp = num(t.timestamp);
  const price = num(t.price);
  const size = num(t.size);
  const usd = num(t.usd_amount);
  if (![id, timestamp, price, size, usd].every(Number.isFinite) || typeof t.is_maker_ask !== 'boolean') return null;
  return {
    id,
    timestamp,
    price,
    size,
    usd,
    buy: t.is_maker_ask,
    type: typeof t.type === 'string' ? t.type : 'trade',
  };
}

export function parseLighterFrame(text: string): LighterFrame {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid', reason: 'not an object' };
    msg = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'invalid', reason: 'not json' };
  }
  const type = msg.type;
  if (type === 'connected') return { kind: 'connected' };
  if (type === 'pong') return { kind: 'pong' };
  if (type === 'error' || (type === undefined && msg.error !== undefined)) {
    return { kind: 'error', message: JSON.stringify(msg.error ?? msg).slice(0, 300) };
  }
  if (type === 'subscribed/order_book' || type === 'update/order_book') {
    const marketId = marketIdOf(msg.channel);
    const ob = msg.order_book as Record<string, unknown> | undefined;
    if (marketId === null || !ob || typeof ob !== 'object') return { kind: 'invalid', reason: 'order_book shape' };
    const asks = parseLevels(ob.asks);
    const bids = parseLevels(ob.bids);
    const nonce = num(ob.nonce);
    const beginNonce = num(ob.begin_nonce);
    const lastUpdatedUs = num(msg.last_updated_at);
    const ts = Number.isFinite(num(msg.timestamp)) ? num(msg.timestamp) : Math.floor(lastUpdatedUs / 1000);
    if (!asks || !bids || !Number.isFinite(nonce) || !Number.isFinite(beginNonce) || !Number.isFinite(ts)) {
      return { kind: 'invalid', reason: 'order_book fields' };
    }
    return { kind: 'book', snapshot: type === 'subscribed/order_book', marketId, timestamp: ts, beginNonce, nonce, asks, bids };
  }
  if (type === 'subscribed/trade' || type === 'update/trade') {
    const marketId = marketIdOf(msg.channel);
    if (marketId === null) return { kind: 'invalid', reason: 'trade channel' };
    const trades: LighterTrade[] = [];
    for (const key of ['trades', 'liquidation_trades'] as const) {
      const list = msg[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) return { kind: 'invalid', reason: `${key} shape` };
      for (const raw of list) {
        const trade = parseTrade(raw);
        if (!trade) return { kind: 'invalid', reason: `${key} entry` };
        trades.push(trade);
      }
    }
    trades.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
    return { kind: 'trades', snapshot: type === 'subscribed/trade', marketId, trades };
  }
  return { kind: 'ignored' };
}

export interface LighterFeedConfig extends ConnectionConfig {
  /** Client subscription messages a minute. Lighter allows 200. */
  msgsPerMinute: number;
  /** A requested snapshot that has not arrived after this long is requested again. */
  snapshotTimeoutMs: number;
  subscriptionCheckEveryMs: number;
  /** Trade ids remembered per market for de-duplication. */
  tradeMemory: number;
  /** A market unsynced this long (connection up) writes a `stuck` gap line, then one per `stuckRepeatMs`. */
  stuckAfterMs: number;
  stuckRepeatMs: number;
}

export const DEFAULT_LIGHTER_CONFIG: Partial<LighterFeedConfig> = {
  keepaliveEveryMs: 15_000,
  keepaliveMessage: JSON.stringify({ type: 'ping' }),
  msgsPerMinute: 150,
  snapshotTimeoutMs: 15_000,
  subscriptionCheckEveryMs: 5_000,
  tradeMemory: 2_000,
  stuckAfterMs: 60_000,
  stuckRepeatMs: 3_600_000,
};

interface MarketState {
  market: TapeMarket;
  book: OrderBook;
  synced: boolean;
  everSynced: boolean;
  lastNonce: number | null;
  exch: number | null;
  recv: number | null;
  unsyncedSince: number | null;
  unsyncedReason: GapReason;
  /** When the current subscribe message was sent; null when none is outstanding. */
  requestedAt: number | null;
  /** Since when the market has been waiting for a snapshot (null while synced). */
  waitingSince: number | null;
  /** When a long-unsynced gap was last reported for this market. */
  stuckReportedAt: number | null;
  lastTradeTs: number | null;
  tradesSeeded: boolean;
  seenTrades: Set<number>;
  seenOrder: number[];
}

interface Outgoing {
  data: string;
  onSent?: () => void;
}

export interface LighterFeedDeps {
  markets: TapeMarket[];
  url?: string;
  socketFactory: TapeSocketFactory;
  now: () => number;
  random?: () => number;
  log: LogFn;
  onTrade(row: TradeRow): void;
  onGap(gap: GapReport): void;
  config?: Partial<LighterFeedConfig>;
}

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

export class LighterFeed {
  private readonly cfg: LighterFeedConfig;
  private readonly conn: ReconnectingConnection;
  private readonly states = new Map<number, MarketState>();
  private readonly byCoin = new Map<string, MarketState>();
  private readonly queue: Outgoing[] = [];
  private pumpTimer: Timer | null = null;
  private lastSentAt = -Infinity;
  private checkTimer: Interval | null = null;
  private stopped = false;
  private errorsLogged = 0;
  private invalidLogged = 0;
  counters = { frames: 0, bookUpdates: 0, trades: 0, nonceBreaks: 0, invalid: 0, duplicateTrades: 0 };

  constructor(private readonly deps: LighterFeedDeps) {
    this.cfg = { ...DEFAULT_CONNECTION_CONFIG, ...DEFAULT_LIGHTER_CONFIG, ...deps.config } as LighterFeedConfig;
    for (const market of deps.markets) {
      const state: MarketState = {
        market,
        book: new OrderBook(),
        synced: false,
        everSynced: false,
        lastNonce: null,
        exch: null,
        recv: null,
        unsyncedSince: null,
        unsyncedReason: 'resubscribe',
        requestedAt: null,
        waitingSince: null,
        stuckReportedAt: null,
        lastTradeTs: null,
        tradesSeeded: false,
        seenTrades: new Set(),
        seenOrder: [],
      };
      this.states.set(market.lighterMarketId, state);
      this.byCoin.set(market.coin, state);
    }
    this.conn = new ReconnectingConnection({
      name: 'lighter',
      url: deps.url ?? DEFAULT_LIGHTER_WS_URL,
      socketFactory: deps.socketFactory,
      now: deps.now,
      random: deps.random,
      log: deps.log,
      config: this.cfg,
      onOpen: () => this.onOpen(),
      onFrame: (data, recv) => this.onFrame(data, recv),
      onLost: (info) => this.onLost(info),
      onGapClosed: (gap) => this.onGapClosed(gap),
    });
  }

  get connected(): boolean {
    return this.conn.connected;
  }

  get marketCount(): number {
    return this.states.size;
  }

  start(): void {
    this.conn.start();
    this.checkTimer = setInterval(() => this.checkSubscriptions(), this.cfg.subscriptionCheckEveryMs);
  }

  /** Stops the feed. Returns the start of an open connection gap, if any. */
  stop(): { reason: LostInfo['reason']; from: number } | null {
    this.stopped = true;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    this.clearQueue();
    return this.conn.stop();
  }

  /** Markets that are not synced now, with the start of each outage. Used to close gaps on shutdown. */
  unsyncedMarkets(): Array<{ coin: string; from: number; reason: GapReason }> {
    const out: Array<{ coin: string; from: number; reason: GapReason }> = [];
    for (const s of this.states.values()) {
      if (!s.synced && s.unsyncedSince !== null) out.push({ coin: s.market.coin, from: s.unsyncedSince, reason: s.unsyncedReason });
    }
    return out;
  }

  /** Summed book work counters (sorts, depth walks, summary computations), for diagnostics and tests. */
  workStats(): { sorts: number; walks: number; summaries: number } {
    const total = { sorts: 0, walks: 0, summaries: 0 };
    for (const s of this.states.values()) {
      total.sorts += s.book.stats.sorts;
      total.walks += s.book.stats.walks;
      total.summaries += s.book.stats.summaries;
    }
    return total;
  }

  /** Levels held per market, for diagnostics. */
  bookLevels(): Array<{ coin: string; bids: number; asks: number }> {
    return [...this.states.values()].map((s) => ({ coin: s.market.coin, bids: s.book.bidCount, asks: s.book.askCount }));
  }

  quote(coin: string): QuoteState | null {
    const s = this.byCoin.get(coin);
    if (!s) return null;
    if (!s.synced) {
      return {
        ok: false,
        exch: s.exch,
        recv: s.recv,
        bid: null,
        ask: null,
        bidSz: null,
        askSz: null,
        rt100: null,
        rt1000: null,
        rt5000: null,
        rt20000: null,
      };
    }
    return { ok: true, exch: s.exch, recv: s.recv, ...s.book.summary() };
  }

  // --- Connection events ---------------------------------------------------

  private onOpen(): void {
    this.clearQueue();
    const now = this.deps.now();
    for (const s of this.states.values()) {
      // The stuck clock restarts with each connection, so a long outage does not report every market at once.
      if (!s.synced) {
        s.waitingSince = now;
        s.stuckReportedAt = null;
      }
      const id = s.market.lighterMarketId;
      this.enqueue(this.subscribeMessage('order_book', id), () => (s.requestedAt = this.deps.now()));
      this.enqueue(this.subscribeMessage('trade', id));
    }
  }

  private onLost(info: LostInfo): void {
    this.clearQueue();
    for (const s of this.states.values()) {
      s.requestedAt = null;
      if (s.synced) this.markUnsynced(s, 'resubscribe', s.recv ?? info.lastFrameAt);
    }
  }

  private onGapClosed(gap: ClosedGap): void {
    this.deps.onGap({ venue: 'lighter', coin: null, reason: gap.reason, from: gap.from, to: gap.to });
  }

  private markUnsynced(s: MarketState, reason: GapReason, since: number): void {
    s.synced = false;
    s.lastNonce = null;
    if (s.waitingSince === null) s.waitingSince = since;
    if (s.everSynced) {
      s.unsyncedSince = since;
      s.unsyncedReason = reason;
    }
  }

  // --- Frames --------------------------------------------------------------

  private onFrame(text: string, recv: number): void {
    this.counters.frames++;
    const frame = parseLighterFrame(text);
    switch (frame.kind) {
      case 'book':
        this.onBook(frame, recv);
        break;
      case 'trades':
        this.onTrades(frame, recv);
        break;
      case 'error':
        if (this.errorsLogged++ < 20) this.deps.log('lighter-error-frame', { message: frame.message });
        break;
      case 'invalid':
        this.counters.invalid++;
        if (this.invalidLogged++ < 5) this.deps.log('lighter-invalid-frame', { reason: frame.reason, sample: text.slice(0, 200) });
        break;
      default:
        break;
    }
  }

  private onBook(frame: Extract<LighterFrame, { kind: 'book' }>, recv: number): void {
    const s = this.states.get(frame.marketId);
    if (!s) return;
    if (frame.snapshot) {
      s.book.applySnapshot(frame.asks, frame.bids);
      if (s.book.isCrossed()) {
        this.breakBook(s, 'crossed-book', recv, 'snapshot with best bid at or above best ask');
        return;
      }
      s.synced = true;
      s.waitingSince = null;
      s.stuckReportedAt = null;
      s.lastNonce = frame.nonce;
      s.exch = frame.timestamp;
      s.recv = recv;
      s.requestedAt = null;
      if (s.unsyncedSince !== null) {
        this.deps.onGap({ venue: 'lighter', coin: s.market.coin, reason: s.unsyncedReason, from: s.unsyncedSince, to: recv });
        s.unsyncedSince = null;
      }
      s.everSynced = true;
      return;
    }
    if (!s.synced) return;
    if (frame.beginNonce !== s.lastNonce) {
      this.breakBook(s, 'nonce-break', recv, `expected begin_nonce ${s.lastNonce}, got ${frame.beginNonce}`);
      return;
    }
    s.book.applyDelta(frame.asks, frame.bids);
    s.lastNonce = frame.nonce;
    s.exch = frame.timestamp;
    s.recv = recv;
    this.counters.bookUpdates++;
    if (s.book.isCrossed()) this.breakBook(s, 'crossed-book', recv, 'best bid at or above best ask');
  }

  private breakBook(s: MarketState, reason: GapReason, recv: number, detail: string): void {
    this.counters.nonceBreaks++;
    this.markUnsynced(s, reason, s.recv ?? recv);
    this.deps.log('book-break', { coin: s.market.coin, reason, detail });
    this.resubscribe(s);
  }

  private onTrades(frame: Extract<LighterFrame, { kind: 'trades' }>, recv: number): void {
    const s = this.states.get(frame.marketId);
    if (!s) return;
    // The subscribe snapshot repeats the last 50 prints. On the first
    // subscription of this process they are history: they only seed the
    // de-duplication memory. After a reconnect the ones newer than the last
    // print seen fill the outage.
    const seedOnly = frame.snapshot && !s.tradesSeeded;
    if (frame.snapshot) s.tradesSeeded = true;
    const floor = frame.snapshot ? s.lastTradeTs : null;
    for (const t of frame.trades) {
      if (s.seenTrades.has(t.id)) {
        this.counters.duplicateTrades++;
        continue;
      }
      // Strictly older only: an unseen print in the same millisecond as the last one seen is kept (the id set removes real duplicates).
      if (floor !== null && t.timestamp < floor) continue;
      s.seenTrades.add(t.id);
      s.seenOrder.push(t.id);
      if (s.seenOrder.length > this.cfg.tradeMemory) s.seenTrades.delete(s.seenOrder.shift() as number);
      if (s.lastTradeTs === null || t.timestamp > s.lastTradeTs) s.lastTradeTs = t.timestamp;
      if (seedOnly) continue;
      this.counters.trades++;
      this.deps.onTrade({
        t: t.timestamp,
        recv,
        coin: s.market.coin,
        px: t.price,
        sz: t.size,
        usd: t.usd,
        buy: t.buy,
        type: t.type,
      });
    }
  }

  // --- Subscriptions -------------------------------------------------------

  private subscribeMessage(channel: 'order_book' | 'trade', id: number, type = 'subscribe'): string {
    return JSON.stringify({ type, channel: `${channel}/${id}` });
  }

  private resubscribe(s: MarketState): void {
    const id = s.market.lighterMarketId;
    s.requestedAt = null;
    this.enqueue(this.subscribeMessage('order_book', id, 'unsubscribe'));
    this.enqueue(this.subscribeMessage('order_book', id), () => (s.requestedAt = this.deps.now()));
  }

  private checkSubscriptions(): void {
    if (!this.conn.connected || this.stopped) return;
    const now = this.deps.now();
    for (const s of this.states.values()) {
      if (!s.synced && s.waitingSince !== null) {
        const due = s.stuckReportedAt === null ? this.cfg.stuckAfterMs : this.cfg.stuckRepeatMs;
        if (now - (s.stuckReportedAt ?? s.waitingSince) >= due) {
          s.stuckReportedAt = now;
          this.deps.log('market-stuck', { coin: s.market.coin, waitingMs: now - s.waitingSince });
          this.deps.onGap({ venue: 'lighter', coin: s.market.coin, reason: 'stuck', from: s.waitingSince, to: now });
        }
      }
      if (s.synced || s.requestedAt === null) continue;
      if (now - s.requestedAt < this.cfg.snapshotTimeoutMs) continue;
      this.deps.log('snapshot-timeout', { coin: s.market.coin, waitedMs: now - s.requestedAt });
      this.resubscribe(s);
    }
  }

  private enqueue(data: string, onSent?: () => void): void {
    this.queue.push({ data, onSent });
    this.pump();
  }

  private clearQueue(): void {
    this.queue.length = 0;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
  }

  private pump(): void {
    if (this.pumpTimer || this.stopped) return;
    const spacing = Math.ceil(60_000 / Math.max(1, this.cfg.msgsPerMinute));
    while (this.queue.length > 0) {
      const now = this.deps.now();
      const wait = this.lastSentAt + spacing - now;
      if (wait > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.pump();
        }, wait);
        return;
      }
      const item = this.queue[0];
      if (!this.conn.send(item.data)) return;
      this.queue.shift();
      this.lastSentAt = now;
      item.onSent?.();
    }
  }
}
