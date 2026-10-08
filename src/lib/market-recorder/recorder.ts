import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff';
import { parseStreamMessage, type LiquidationRecord } from './messages';
import { buildStreamUrl, sameSymbolSet, type RankedSymbol, type SymbolSelection } from './symbols';
import {
  TradeFlowAggregator,
  type TradeFlowAggregatorOptions,
  type TradeFlowBarRecord,
} from './trade-flow';

/**
 * The market recorder's connection, buffering and write loop. Every side
 * effect is injected (socket factory, store, universe fetch, clock, random,
 * log) and every schedule is a plain `setTimeout`/`setInterval`, so the whole
 * lifecycle runs under fake timers in tests. `scripts/ops/market-recorder.ts`
 * wires the real ones; its header states what the data is and is not for.
 *
 * CONNECTIONS. One combined stream carries `!forceOrder@arr` and one
 * `<symbol>@aggTrade` per selected symbol. A planned reconnect 23 hours after
 * a connection opens (Binance closes at 24) and a changed symbol set both
 * swap connections make-before-break: the new one opens, both run for
 * `overlapMs`, then the old one closes. The overlap's duplicate trades are
 * dropped by id in the aggregator and duplicate liquidations by the
 * collection's unique key, so a swap loses nothing and writes no gap.
 *
 * GAPS. An unplanned loss (close, error, connect timeout, or no message for
 * `staleAfterMs`) with no other connection open starts a gap at the last
 * message received; the next open closes it and queues a `recordergaps` row.
 * Reconnects back off exponentially with jitter, capped, and the attempt count
 * resets only after a connection has stayed up `stableConnectionMs`.
 *
 * WRITES. Closed trade-flow bars are drained every `barFlushEveryMs`;
 * liquidations, gaps and symbol sets every `fastFlushEveryMs` (and sooner when
 * `liquidationBatch` events wait). A failed write keeps its rows for the next
 * tick. Every buffer is capped; past the cap the oldest rows are dropped and
 * counted in the heartbeat, so a long Mongo outage costs data, never memory.
 */

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number | null, reason: string): void;
  onError(message: string): void;
}

export interface SocketHandle {
  /** Detaches every handler, then closes. No handler fires afterwards. */
  close(): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

/** The slice of the WHATWG WebSocket the recorder uses; Node 22's global and the test mock both fit. */
export interface WebSocketLike {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close(): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

function errorText(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev) {
    const message = (ev as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'websocket error';
}

export function webSocketFactory(Ctor: WebSocketConstructor): SocketFactory {
  return (url, handlers) => {
    const ws = new Ctor(url);
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (ev) => handlers.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    ws.onclose = (ev) => {
      const { code, reason } = (ev ?? {}) as { code?: unknown; reason?: unknown };
      handlers.onClose(typeof code === 'number' ? code : null, typeof reason === 'string' ? reason : '');
    };
    ws.onerror = (ev) => handlers.onError(errorText(ev));
    return {
      close() {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // Already closing or closed.
        }
      },
    };
  };
}

export interface RecorderGapRecord {
  start: number;
  /** Null: still open, closed by the next process's first connection. */
  end: number | null;
  reason: string;
}

export interface RecorderSymbolSetRecord {
  refreshedAt: number;
  topN: number;
  eligibleCount: number;
  symbols: RankedSymbol[];
  changed: boolean;
}

export interface HeartbeatOutcome {
  ok: boolean;
  durationMs: number;
  result: unknown;
  error: string | null;
}

export interface RecorderStore {
  /** Idempotent on the liquidation key. Returns rows newly stored. */
  writeLiquidations(events: readonly LiquidationRecord[]): Promise<number>;
  /** Upsert on (symbol, bucketStart), merging a disjoint part. Returns rows touched. */
  writeTradeFlowBars(bars: readonly TradeFlowBarRecord[]): Promise<number>;
  writeGap(gap: RecorderGapRecord): Promise<void>;
  /** Sets `end` on every open gap row. Returns how many were open. */
  closeOpenGaps(end: number): Promise<number>;
  /** The previous process's last healthy heartbeat, epoch ms. */
  lastHealthyAt(): Promise<number | null>;
  writeSymbolSet(set: RecorderSymbolSetRecord): Promise<void>;
  /** Must not throw. */
  heartbeat(outcome: HeartbeatOutcome): Promise<void>;
}

export interface RecorderConfig {
  symbolRefreshMs: number;
  symbolRetryMs: number;
  plannedReconnectMs: number;
  rotationRetryMs: number;
  overlapMs: number;
  connectTimeoutMs: number;
  staleAfterMs: number;
  watchdogEveryMs: number;
  barFlushEveryMs: number;
  fastFlushEveryMs: number;
  liquidationBatch: number;
  heartbeatEveryMs: number;
  stableConnectionMs: number;
  /** Disconnected this long, the heartbeat reports failure. */
  heartbeatFailAfterMs: number;
  maxPendingBars: number;
  maxPendingLiquidations: number;
  maxPendingMeta: number;
  writeChunk: number;
  shutdownFlushTimeoutMs: number;
  backoff: BackoffOptions;
  aggregator: Partial<TradeFlowAggregatorOptions>;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** setTimeout fires at once for anything above 2^31 - 1 ms, so every delay is clamped. */
const MAX_TIMER_MS = 2_147_483_647;

function timerMs(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_TIMER_MS);
}

export const DEFAULT_RECORDER_CONFIG: RecorderConfig = {
  symbolRefreshMs: 24 * HOUR,
  symbolRetryMs: 5 * MINUTE,
  plannedReconnectMs: 23 * HOUR,
  rotationRetryMs: MINUTE,
  overlapMs: 5 * SECOND,
  connectTimeoutMs: 15 * SECOND,
  staleAfterMs: MINUTE,
  watchdogEveryMs: 10 * SECOND,
  barFlushEveryMs: MINUTE,
  fastFlushEveryMs: 5 * SECOND,
  liquidationBatch: 500,
  heartbeatEveryMs: MINUTE,
  stableConnectionMs: MINUTE,
  heartbeatFailAfterMs: 90 * SECOND,
  // About 16 hours of bars at 50 symbols, a few MB.
  maxPendingBars: 20_000,
  // About a day of liquidations, roughly 15 MB.
  maxPendingLiquidations: 50_000,
  maxPendingMeta: 1_000,
  writeChunk: 500,
  shutdownFlushTimeoutMs: 20 * SECOND,
  backoff: DEFAULT_BACKOFF,
  aggregator: {},
};

export interface RecorderDeps {
  socketFactory: SocketFactory;
  store: RecorderStore;
  fetchUniverse: () => Promise<SymbolSelection>;
  wsBaseUrl: string;
  now?: () => number;
  random?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  config?: Partial<RecorderConfig>;
}

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

interface Conn {
  id: number;
  symbols: string[];
  purpose: 'connect' | 'rotation';
  state: 'connecting' | 'open' | 'closed';
  handle: SocketHandle | null;
  openedAt: number | null;
  lastMessageAt: number | null;
  timers: Set<Timer>;
}

type MetaOp =
  | { kind: 'gap'; gap: RecorderGapRecord }
  /** The first gap of a process: closes the previous process's open rows, else writes `gap`. */
  | { kind: 'startup-gap'; gap: RecorderGapRecord & { end: number } }
  | { kind: 'symbol-set'; set: RecorderSymbolSetRecord };

interface Counters {
  messages: number;
  aggTrades: number;
  duplicateTrades: number;
  overflowTrades: number;
  liquidations: number;
  invalid: number;
  ignored: number;
  barsWritten: number;
  liquidationsStored: number;
  droppedBars: number;
  droppedLiquidations: number;
  droppedMeta: number;
  writeErrors: number;
}

function emptyCounters(): Counters {
  return {
    messages: 0,
    aggTrades: 0,
    duplicateTrades: 0,
    overflowTrades: 0,
    liquidations: 0,
    invalid: 0,
    ignored: 0,
    barsWritten: 0,
    liquidationsStored: 0,
    droppedBars: 0,
    droppedLiquidations: 0,
    droppedMeta: 0,
    writeErrors: 0,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Invalid frames logged per heartbeat interval, so a schema change cannot flood the log. */
const INVALID_LOG_LIMIT = 5;

export class MarketRecorder {
  private readonly cfg: RecorderConfig;
  private readonly socketFactory: SocketFactory;
  private readonly store: RecorderStore;
  private readonly fetchUniverse: () => Promise<SymbolSelection>;
  private readonly wsBaseUrl: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logFn: (event: string, fields: Record<string, unknown>) => void;
  private readonly aggregator: TradeFlowAggregator;

  private readonly conns = new Set<Conn>();
  private nextConnId = 1;
  private selection: RankedSymbol[] = [];

  private pendingBars: TradeFlowBarRecord[] = [];
  private pendingLiquidations: LiquidationRecord[] = [];
  private pendingMeta: MetaOp[] = [];

  private startedAt = 0;
  private gapOpenSince: number | null = null;
  private gapReason = '';
  private disconnectedSince: number | null = null;
  private firstOpenDone = false;
  private attempt = 0;

  private reconnectTimer: Timer | null = null;
  private refreshTimer: Timer | null = null;
  private rotationRetryTimer: Timer | null = null;
  private intervals: Interval[] = [];

  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private barFlush: Promise<void> | null = null;
  private fastFlush: Promise<void> | null = null;
  /** A fast flush was requested while one ran; it runs again once more. */
  private fastFlushRequested = false;

  private lastHeartbeatAt = 0;
  /** Write kinds whose most recent attempt failed. A success of one kind cannot hide another failing. */
  private readonly failingWrites = new Set<string>();
  private lastWriteError: { at: number; message: string } | null = null;
  private counters: Counters = emptyCounters();
  private invalidLogged = 0;

  constructor(deps: RecorderDeps) {
    this.cfg = { ...DEFAULT_RECORDER_CONFIG, ...deps.config };
    this.socketFactory = deps.socketFactory;
    this.store = deps.store;
    this.fetchUniverse = deps.fetchUniverse;
    this.wsBaseUrl = deps.wsBaseUrl;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.logFn =
      deps.log ??
      ((event, fields) => console.log(JSON.stringify({ ts: new Date(this.now()).toISOString(), event, ...fields })));
    this.aggregator = new TradeFlowAggregator(this.cfg.aggregator);
  }

  /** Fetches the universe, opens the first connection and starts every schedule. */
  async start(): Promise<void> {
    this.startedAt = this.now();
    this.lastHeartbeatAt = this.startedAt;
    this.disconnectedSince = this.startedAt;

    let previousHealthyAt: number | null = null;
    try {
      previousHealthyAt = await this.store.lastHealthyAt();
    } catch (err) {
      this.log('startup-read-error', { error: message(err) });
    }
    // A crash leaves no shutdown row, so the gap is taken back to the last
    // moment the previous process reported itself healthy: over-stated, never missed.
    this.gapOpenSince =
      previousHealthyAt !== null && previousHealthyAt < this.startedAt ? previousHealthyAt : this.startedAt;
    this.gapReason = 'process-start';
    this.log('starting', {
      previousHealthyAt: previousHealthyAt !== null ? new Date(previousHealthyAt).toISOString() : null,
    });

    await this.refreshSymbols();
    if (this.stopping) return;

    this.connect('connect');
    this.intervals.push(
      setInterval(() => this.watchdog(), this.cfg.watchdogEveryMs),
      setInterval(() => void this.flushBars(), this.cfg.barFlushEveryMs),
      setInterval(() => void this.flushFast(), this.cfg.fastFlushEveryMs),
      setInterval(() => void this.heartbeat(), this.cfg.heartbeatEveryMs)
    );
  }

  /**
   * Graceful stop: closes every connection, marks the bars still open
   * incomplete, writes an open-ended `shutdown` gap and flushes every buffer,
   * giving up after `shutdownFlushTimeoutMs`. Idempotent.
   */
  stop(signal: string): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.doStop(signal);
    return this.stopPromise;
  }

  // --- Symbols -------------------------------------------------------------

  private async refreshSymbols(): Promise<void> {
    let nextInMs = this.cfg.symbolRefreshMs;
    try {
      const selection = await this.fetchUniverse();
      if (this.stopping) return;
      const changed = !sameSymbolSet(
        this.selection.map((s) => s.symbol),
        selection.symbols.map((s) => s.symbol)
      );
      this.selection = selection.symbols;
      this.enqueueMeta({
        kind: 'symbol-set',
        set: {
          refreshedAt: this.now(),
          topN: selection.topN,
          eligibleCount: selection.eligibleCount,
          symbols: selection.symbols,
          changed,
        },
      });
      this.log('symbols', {
        count: selection.symbols.length,
        eligible: selection.eligibleCount,
        changed,
      });
      if (changed && this.conns.size > 0) this.rotate('symbol set changed');
    } catch (err) {
      nextInMs = this.cfg.symbolRetryMs;
      this.log('symbols-error', { error: message(err), retryInMs: nextInMs });
    }
    if (!this.stopping) {
      this.refreshTimer = setTimeout(() => void this.refreshSymbols(), timerMs(nextInMs));
    }
  }

  private currentSymbols(): string[] {
    return this.selection.map((s) => s.symbol);
  }

  // --- Connections ---------------------------------------------------------

  private anyOpen(): boolean {
    for (const c of this.conns) if (c.state === 'open') return true;
    return false;
  }

  private anyConnecting(): boolean {
    for (const c of this.conns) if (c.state === 'connecting') return true;
    return false;
  }

  private addTimer(conn: Conn, fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      conn.timers.delete(timer);
      fn();
    }, timerMs(ms));
    conn.timers.add(timer);
  }

  private clearTimers(conn: Conn): void {
    for (const t of conn.timers) clearTimeout(t);
    conn.timers.clear();
  }

  private connect(purpose: Conn['purpose']): void {
    if (this.stopping) return;
    const symbols = this.currentSymbols();
    const conn: Conn = {
      id: this.nextConnId++,
      symbols,
      purpose,
      state: 'connecting',
      handle: null,
      openedAt: null,
      lastMessageAt: null,
      timers: new Set(),
    };
    this.conns.add(conn);
    this.log('connecting', { conn: conn.id, purpose, streams: symbols.length + 1 });

    this.addTimer(
      conn,
      () => {
        if (conn.state === 'connecting') this.lose(conn, 'connect-timeout');
      },
      this.cfg.connectTimeoutMs
    );

    try {
      conn.handle = this.socketFactory(buildStreamUrl(this.wsBaseUrl, symbols), {
        onOpen: () => this.onOpen(conn),
        onMessage: (data) => this.onMessage(conn, data),
        onClose: (code, reason) => this.lose(conn, `closed ${code ?? 'without code'}${reason ? `: ${reason}` : ''}`),
        onError: (msg) => this.log('socket-error', { conn: conn.id, message: msg }),
      });
    } catch (err) {
      this.lose(conn, `connect failed: ${message(err)}`);
    }
  }

  private onOpen(conn: Conn): void {
    if (conn.state !== 'connecting' || this.stopping) return;
    const now = this.now();
    conn.state = 'open';
    conn.openedAt = now;
    conn.lastMessageAt = now;
    this.clearTimers(conn);
    this.disconnectedSince = null;
    this.aggregator.setCovered(conn.symbols, now);
    if (this.gapOpenSince !== null) this.closeGap(now);

    for (const other of this.conns) {
      if (other !== conn && other.state === 'open') {
        this.addTimer(other, () => this.retire(other, `replaced by conn ${conn.id}`), this.cfg.overlapMs);
      }
    }
    this.addTimer(
      conn,
      () => this.rotate('planned reconnect before the 24-hour limit'),
      this.cfg.plannedReconnectMs
    );
    this.log('connected', { conn: conn.id, purpose: conn.purpose, symbols: conn.symbols.length });

    // A refresh that landed while this connection was opening.
    if (!sameSymbolSet(conn.symbols, this.currentSymbols())) this.rotate('symbol set changed while connecting');
  }

  private onMessage(conn: Conn, data: string): void {
    if (conn.state !== 'open') return;
    const now = this.now();
    conn.lastMessageAt = now;
    this.counters.messages++;

    const parsed = parseStreamMessage(data, now);
    switch (parsed.kind) {
      case 'aggTrade': {
        const result = this.aggregator.add(parsed.trade);
        if (result === 'added') this.counters.aggTrades++;
        else if (result === 'duplicate') this.counters.duplicateTrades++;
        else this.counters.overflowTrades++;
        break;
      }
      case 'liquidations': {
        for (const event of parsed.events) this.pushLiquidation(event);
        this.counters.invalid += parsed.invalid;
        if (this.pendingLiquidations.length >= this.cfg.liquidationBatch) void this.flushFast();
        break;
      }
      case 'ignored':
        this.counters.ignored++;
        break;
      case 'invalid':
        this.counters.invalid++;
        if (this.invalidLogged < INVALID_LOG_LIMIT) {
          this.invalidLogged++;
          this.log('invalid-message', { conn: conn.id, error: parsed.error, sample: data.slice(0, 200) });
        }
        break;
    }
  }

  /** An unplanned loss: close, error, connect timeout or stale stream. */
  private lose(conn: Conn, reason: string): void {
    if (conn.state === 'closed') return;
    const now = this.now();
    const wasOpen = conn.state === 'open';
    // Data stopped at the last message, not when the loss was noticed.
    const breakAt = wasOpen ? Math.min(now, conn.lastMessageAt ?? now) : now;
    this.dispose(conn);
    if (this.stopping) return;

    this.uncover(conn, breakAt);
    this.log('disconnected', {
      conn: conn.id,
      reason,
      wasOpen,
      openForMs: wasOpen && conn.openedAt !== null ? now - conn.openedAt : 0,
    });

    if (wasOpen && conn.openedAt !== null && now - conn.openedAt >= this.cfg.stableConnectionMs) {
      this.attempt = 0;
    }

    if (!this.anyOpen()) {
      // Health counts from when the loss was noticed; the gap row from the last message.
      if (this.disconnectedSince === null) this.disconnectedSince = now;
      if (this.gapOpenSince === null) {
        this.gapOpenSince = breakAt;
        this.gapReason = reason;
      }
      if (!this.anyConnecting()) this.scheduleReconnect();
    } else if (conn.purpose === 'rotation') {
      // The replacement failed while the old connection still serves.
      this.scheduleRotationRetry();
    }
  }

  /** A planned close once a replacement is open. */
  private retire(conn: Conn, reason: string): void {
    if (conn.state !== 'open') return;
    let replaced = false;
    for (const c of this.conns) if (c !== conn && c.state === 'open') replaced = true;
    // The replacement died during the overlap: keep serving on this one.
    if (!replaced) return;
    this.dispose(conn);
    this.uncover(conn, this.now());
    this.log('retired', { conn: conn.id, reason });
  }

  private dispose(conn: Conn): void {
    conn.state = 'closed';
    this.clearTimers(conn);
    this.conns.delete(conn);
    const handle = conn.handle;
    conn.handle = null;
    try {
      handle?.close();
    } catch {
      // Nothing to do: the connection is gone either way.
    }
  }

  /** Ends coverage for the symbols only `conn` carried. */
  private uncover(conn: Conn, at: number): void {
    const stillCovered = new Set<string>();
    for (const c of this.conns) {
      if (c.state === 'open') for (const s of c.symbols) stillCovered.add(s);
    }
    this.aggregator.breakCoverage(
      conn.symbols.filter((s) => !stillCovered.has(s)),
      at
    );
    this.aggregator.retainDedupe([...stillCovered, ...this.currentSymbols()]);
  }

  private rotate(reason: string): void {
    if (this.stopping) return;
    // One opening at a time; its open handler re-checks the symbol set.
    if (this.anyConnecting()) return;
    // Disconnected: the pending reconnect already uses the current set.
    if (!this.anyOpen()) return;
    this.log('rotating', { reason });
    this.connect('rotation');
  }

  private scheduleRotationRetry(): void {
    if (this.stopping || this.rotationRetryTimer) return;
    this.rotationRetryTimer = setTimeout(() => {
      this.rotationRetryTimer = null;
      this.rotate('retrying a failed swap');
    }, timerMs(this.cfg.rotationRetryMs));
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = backoffDelay(this.attempt, this.random, this.cfg.backoff);
    this.attempt++;
    this.log('reconnect-scheduled', { inMs: delay, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect('connect');
    }, timerMs(delay));
  }

  private watchdog(): void {
    const now = this.now();
    for (const conn of [...this.conns]) {
      // A liquidation-only stream (no symbols yet) can be quiet for minutes.
      if (conn.state !== 'open' || conn.symbols.length === 0) continue;
      const silentFor = now - (conn.lastMessageAt ?? now);
      if (silentFor > this.cfg.staleAfterMs) {
        this.lose(conn, `stale: no message for ${Math.round(silentFor / SECOND)} s`);
      }
    }
  }

  // --- Gaps ----------------------------------------------------------------

  private closeGap(end: number): void {
    const start = this.gapOpenSince!;
    const reason = this.gapReason;
    this.gapOpenSince = null;
    this.gapReason = '';
    const fields = { start: new Date(start).toISOString(), durationMs: end - start, reason };
    if (!this.firstOpenDone) {
      this.firstOpenDone = true;
      this.enqueueMeta({ kind: 'startup-gap', gap: { start, end, reason } });
      // The span is only a fallback: a predecessor's open shutdown row wins.
      this.log('first-connection', { ...fields, rowWritten: 'closes an open shutdown row if one exists, else this span' });
    } else {
      this.enqueueMeta({ kind: 'gap', gap: { start, end, reason } });
      this.log('gap-closed', fields);
    }
    void this.flushFast();
  }

  // --- Buffers and writes --------------------------------------------------

  private pushLiquidation(event: LiquidationRecord): void {
    this.counters.liquidations++;
    this.pendingLiquidations.push(event);
    const excess = this.pendingLiquidations.length - this.cfg.maxPendingLiquidations;
    if (excess > 0) {
      this.pendingLiquidations.splice(0, excess);
      this.counters.droppedLiquidations += excess;
    }
  }

  private enqueueBars(bars: TradeFlowBarRecord[], atFront = false): void {
    if (bars.length === 0) return;
    this.pendingBars = atFront ? bars.concat(this.pendingBars) : this.pendingBars.concat(bars);
    const excess = this.pendingBars.length - this.cfg.maxPendingBars;
    if (excess > 0) {
      this.pendingBars.splice(0, excess);
      this.counters.droppedBars += excess;
    }
  }

  private enqueueMeta(op: MetaOp): void {
    // Past the cap the NEWEST op is dropped: the head may be mid-write.
    if (this.pendingMeta.length >= this.cfg.maxPendingMeta) {
      this.counters.droppedMeta++;
      return;
    }
    this.pendingMeta.push(op);
  }

  private noteWriteOk(what: string): void {
    this.failingWrites.delete(what);
  }

  private noteWriteError(what: string, err: unknown): void {
    this.failingWrites.add(what);
    this.lastWriteError = { at: this.now(), message: `${what}: ${message(err)}` };
    this.counters.writeErrors++;
    this.log('write-error', { what, error: message(err) });
  }

  private flushBars(): Promise<void> {
    if (this.barFlush) return this.barFlush;
    this.barFlush = (async () => {
      try {
        this.enqueueBars(this.aggregator.drainClosed(this.now()));
        await this.writeBars();
      } finally {
        this.barFlush = null;
      }
    })();
    return this.barFlush;
  }

  private flushFast(): Promise<void> {
    if (this.fastFlush) {
      // The running pass may already be past the liquidations; run once more.
      this.fastFlushRequested = true;
      return this.fastFlush;
    }
    this.fastFlush = (async () => {
      try {
        do {
          this.fastFlushRequested = false;
          await this.writeLiquidations();
          await this.writeMeta();
          // Never spin against a failing store: the next tick retries.
        } while (this.fastFlushRequested && this.failingWrites.size === 0);
      } finally {
        this.fastFlush = null;
      }
    })();
    return this.fastFlush;
  }

  private async writeBars(): Promise<void> {
    while (this.pendingBars.length > 0) {
      const chunk = this.pendingBars.splice(0, this.cfg.writeChunk);
      try {
        await this.store.writeTradeFlowBars(chunk);
        this.counters.barsWritten += chunk.length;
        this.noteWriteOk('trade-flow bars');
      } catch (err) {
        this.enqueueBars(chunk, true);
        this.noteWriteError('trade-flow bars', err);
        return;
      }
    }
  }

  private async writeLiquidations(): Promise<void> {
    while (this.pendingLiquidations.length > 0) {
      const chunk = this.pendingLiquidations.splice(0, this.cfg.writeChunk);
      try {
        this.counters.liquidationsStored += await this.store.writeLiquidations(chunk);
        this.noteWriteOk('liquidations');
      } catch (err) {
        // Back at the front; messages that arrived meanwhile stay behind them.
        this.pendingLiquidations = chunk.concat(this.pendingLiquidations);
        const excess = this.pendingLiquidations.length - this.cfg.maxPendingLiquidations;
        if (excess > 0) {
          this.pendingLiquidations.splice(0, excess);
          this.counters.droppedLiquidations += excess;
        }
        this.noteWriteError('liquidations', err);
        return;
      }
    }
  }

  /** FIFO, stopping at the first failure, so a startup gap is settled before any later row. */
  private async writeMeta(): Promise<void> {
    while (this.pendingMeta.length > 0) {
      const op = this.pendingMeta[0];
      try {
        if (op.kind === 'gap') {
          await this.store.writeGap(op.gap);
        } else if (op.kind === 'startup-gap') {
          const closed = await this.store.closeOpenGaps(op.gap.end);
          // A graceful predecessor left an open row that now spans the restart.
          if (closed === 0) await this.store.writeGap(op.gap);
        } else {
          await this.store.writeSymbolSet(op.set);
        }
        this.pendingMeta.shift();
        this.noteWriteOk('gaps and symbol sets');
      } catch (err) {
        this.noteWriteError('gaps and symbol sets', err);
        return;
      }
    }
  }

  // --- Heartbeat -----------------------------------------------------------

  private healthStatus(now: number): { ok: boolean; error: string | null } {
    if (this.disconnectedSince !== null && now - this.disconnectedSince >= this.cfg.heartbeatFailAfterMs) {
      const seconds = Math.round((now - this.disconnectedSince) / SECOND);
      return { ok: false, error: `not connected for ${seconds} s (${this.gapReason || 'unknown'})` };
    }
    if (this.selection.length === 0) {
      return { ok: false, error: 'no symbols: the universe fetch has not succeeded' };
    }
    if (this.failingWrites.size > 0) {
      return { ok: false, error: `writes failing: ${this.lastWriteError?.message ?? [...this.failingWrites].join(', ')}` };
    }
    return { ok: true, error: null };
  }

  private async heartbeat(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    const status = this.healthStatus(now);
    const result = {
      connected: this.anyOpen(),
      connections: this.conns.size,
      symbols: this.selection.length,
      disconnectedSince: this.disconnectedSince !== null ? new Date(this.disconnectedSince).toISOString() : null,
      uptimeSec: Math.round((now - this.startedAt) / SECOND),
      interval: this.counters,
      openBars: this.aggregator.openBars,
      pending: {
        bars: this.pendingBars.length,
        liquidations: this.pendingLiquidations.length,
        meta: this.pendingMeta.length,
      },
      lastWriteError: this.lastWriteError
        ? { at: new Date(this.lastWriteError.at).toISOString(), message: this.lastWriteError.message }
        : null,
    };
    const durationMs = now - this.lastHeartbeatAt;
    this.lastHeartbeatAt = now;
    this.counters = emptyCounters();
    this.invalidLogged = 0;
    this.log('heartbeat', { ok: status.ok, error: status.error, ...result });
    try {
      await this.store.heartbeat({ ok: status.ok, durationMs, result, error: status.error });
    } catch (err) {
      this.log('heartbeat-error', { error: message(err) });
    }
  }

  // --- Shutdown ------------------------------------------------------------

  private async doStop(signal: string): Promise<void> {
    this.stopping = true;
    const stopAt = this.now();
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    for (const timer of [this.reconnectTimer, this.refreshTimer, this.rotationRetryTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.rotationRetryTimer = null;

    const wasConnected = this.anyOpen();
    const covered = this.aggregator.coveredSymbols();
    for (const conn of [...this.conns]) this.dispose(conn);
    // The bars still open lose their tail.
    this.aggregator.breakCoverage(covered, stopAt);

    // Open-ended: the next process closes it when it connects.
    const gap: RecorderGapRecord =
      !wasConnected && this.gapOpenSince !== null
        ? { start: this.gapOpenSince, end: null, reason: `${this.gapReason}, then shutdown (${signal})` }
        : { start: stopAt, end: null, reason: `shutdown (${signal})` };
    this.enqueueMeta({ kind: 'gap', gap });
    this.log('stopping', { signal, openBars: this.aggregator.openBars });

    await Promise.allSettled([this.barFlush, this.fastFlush].filter((p): p is Promise<void> => p !== null));
    this.enqueueBars(this.aggregator.drainAll());

    const flush = (async () => {
      await this.writeBars();
      await this.writeLiquidations();
      await this.writeMeta();
    })();
    let timer: Timer | null = null;
    const timedOut = await Promise.race([
      flush.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timerMs(this.cfg.shutdownFlushTimeoutMs));
      }),
    ]);
    if (timer) clearTimeout(timer);

    this.log('stopped', {
      signal,
      timedOut,
      unwritten: {
        bars: this.pendingBars.length,
        liquidations: this.pendingLiquidations.length,
        meta: this.pendingMeta.length,
      },
    });
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logFn(event, fields);
  }
}
