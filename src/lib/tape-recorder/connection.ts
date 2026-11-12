import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from '@/lib/market-recorder/backoff';

import type { GapReason, LogFn, SocketHandlers, TapeSocket, TapeSocketFactory } from './types';

/**
 * One WebSocket that reconnects by itself: capped exponential backoff with
 * jitter (the market recorder's helper), a connect timeout, a stale watchdog
 * (no frame of any kind for `staleAfterMs` closes and reconnects) and an
 * optional client keepalive. Every unplanned loss is reported once through
 * `onLost`, and the span with no connection is reported once, when the next
 * connection opens, through `onGapClosed`.
 *
 * Every schedule is a plain setTimeout/setInterval and every side effect is
 * injected, so the whole lifecycle runs under fake timers in tests.
 */

export interface ConnectionConfig {
  connectTimeoutMs: number;
  /** No frame for this long: the connection is closed and reopened. */
  staleAfterMs: number;
  watchdogEveryMs: number;
  /** An open connection that survives this long resets the backoff attempt count. */
  stableConnectionMs: number;
  /** 0 disables the keepalive. */
  keepaliveEveryMs: number;
  keepaliveMessage: string;
  backoff: BackoffOptions;
}

export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  connectTimeoutMs: 15_000,
  staleAfterMs: 30_000,
  watchdogEveryMs: 5_000,
  stableConnectionMs: 60_000,
  keepaliveEveryMs: 0,
  keepaliveMessage: '',
  backoff: DEFAULT_BACKOFF,
};

export interface LostInfo {
  reason: Extract<GapReason, 'disconnect' | 'connect-failed' | 'stale'>;
  /** The last frame received, or the time the attempt started when none arrived. */
  lastFrameAt: number;
  at: number;
}

export interface ClosedGap {
  reason: LostInfo['reason'];
  from: number;
  to: number;
}

export interface ConnectionDeps {
  name: string;
  url: string;
  socketFactory: TapeSocketFactory;
  now: () => number;
  random?: () => number;
  log: LogFn;
  config?: Partial<ConnectionConfig>;
  onOpen(): void;
  onFrame(data: string, recv: number): void;
  /** The connection was open or opening and is now gone. Fires once per loss. */
  onLost(info: LostInfo): void;
  /** The connection reopened after a loss; the span without data is `from` to `to`. */
  onGapClosed(gap: ClosedGap): void;
}

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

export class ReconnectingConnection {
  private readonly cfg: ConnectionConfig;
  private readonly random: () => number;
  private socket: TapeSocket | null = null;
  private state: 'idle' | 'connecting' | 'open' | 'backoff' | 'stopped' = 'idle';
  private lastFrameAt = 0;
  private attempt = 0;
  private generation = 0;
  private pendingGap: { reason: LostInfo['reason']; from: number } | null = null;
  private everOpened = false;

  private connectTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private stableTimer: Timer | null = null;
  private watchdog: Interval | null = null;
  private keepalive: Interval | null = null;

  constructor(private readonly deps: ConnectionDeps) {
    this.cfg = { ...DEFAULT_CONNECTION_CONFIG, ...deps.config };
    this.random = deps.random ?? Math.random;
  }

  get connected(): boolean {
    return this.state === 'open';
  }

  get lastFrame(): number {
    return this.lastFrameAt;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.watchdog = setInterval(() => this.checkStale(), this.cfg.watchdogEveryMs);
    this.connect();
  }

  /** Sends one text frame. Returns false when the connection is not open. */
  send(data: string): boolean {
    if (this.state !== 'open' || !this.socket) return false;
    try {
      this.socket.send(data);
      return true;
    } catch (err) {
      this.deps.log('send-error', { conn: this.deps.name, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Closes the socket and cancels every timer. If a gap is open, returns its start and reason. */
  stop(): { reason: LostInfo['reason']; from: number } | null {
    this.state = 'stopped';
    this.generation++;
    this.clearTimers();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.socket?.close();
    this.socket = null;
    return this.pendingGap;
  }

  /** Drops the current socket as if it had failed; the normal reconnect follows. */
  forceReconnect(reason: LostInfo['reason']): void {
    if (this.state === 'open' || this.state === 'connecting') this.lose(reason);
  }

  private clearTimers(): void {
    for (const t of [this.connectTimer, this.reconnectTimer, this.stableTimer]) if (t) clearTimeout(t);
    this.connectTimer = this.reconnectTimer = this.stableTimer = null;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private connect(): void {
    if (this.state === 'stopped') return;
    this.state = 'connecting';
    const generation = ++this.generation;
    const startedAt = this.deps.now();
    this.lastFrameAt = startedAt;
    this.deps.log('connecting', { conn: this.deps.name, attempt: this.attempt });
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (generation === this.generation && this.state === 'connecting') this.lose('connect-failed');
    }, this.cfg.connectTimeoutMs);

    const handlers: SocketHandlers = {
      onOpen: () => {
        if (generation === this.generation) this.handleOpen();
      },
      onMessage: (data) => {
        if (generation === this.generation && this.state === 'open') this.handleFrame(data);
      },
      onClose: (code, reason) => {
        if (generation === this.generation) {
          this.lose('disconnect', `closed ${code ?? 'without code'}${reason ? `: ${reason}` : ''}`);
        }
      },
      onError: (message) => this.deps.log('socket-error', { conn: this.deps.name, message }),
    };
    try {
      this.socket = this.deps.socketFactory(this.deps.url, handlers);
    } catch (err) {
      this.lose('connect-failed', err instanceof Error ? err.message : String(err));
    }
  }

  private handleOpen(): void {
    if (this.state !== 'connecting') return;
    const now = this.deps.now();
    this.state = 'open';
    this.lastFrameAt = now;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.attempt = 0;
    }, this.cfg.stableConnectionMs);
    if (this.cfg.keepaliveEveryMs > 0) {
      this.keepalive = setInterval(() => this.send(this.cfg.keepaliveMessage), this.cfg.keepaliveEveryMs);
    }
    this.deps.log('connected', { conn: this.deps.name, reconnect: this.everOpened });
    this.everOpened = true;
    if (this.pendingGap) {
      const gap = { ...this.pendingGap, to: now };
      this.pendingGap = null;
      this.deps.onGapClosed(gap);
    }
    this.deps.onOpen();
  }

  private handleFrame(data: string): void {
    const now = this.deps.now();
    this.lastFrameAt = now;
    this.deps.onFrame(data, now);
  }

  private checkStale(): void {
    if (this.state !== 'open') return;
    const age = this.deps.now() - this.lastFrameAt;
    if (age > this.cfg.staleAfterMs) this.lose('stale', `no frame for ${age} ms`);
  }

  private lose(reason: LostInfo['reason'], detail?: string): void {
    if (this.state !== 'open' && this.state !== 'connecting') return;
    const at = this.deps.now();
    const lastFrameAt = this.lastFrameAt;
    this.generation++;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.state = 'backoff';
    if (!this.pendingGap) this.pendingGap = { reason, from: lastFrameAt };
    const delay = backoffDelay(this.attempt++, this.random, this.cfg.backoff);
    this.deps.log('connection-lost', { conn: this.deps.name, reason, detail, retryInMs: delay });
    this.deps.onLost({ reason, lastFrameAt, at });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
