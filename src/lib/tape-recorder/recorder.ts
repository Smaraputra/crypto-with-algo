import { performance } from 'node:perf_hooks';

import { BinanceFeed, DEFAULT_BINANCE_WS_URL } from './binance-ws';
import type { ConnectionConfig } from './connection';
import { TapeSink, type SinkConfig, type StatfsResult } from './file-sink';
import { DEFAULT_LIGHTER_WS_URL, LighterFeed, type LighterFeedConfig } from './lighter-ws';
import { Sampler, type SamplerConfig } from './sampler';
import type {
  GapReport,
  GapRow,
  Heartbeat,
  LogFn,
  StreamName,
  TapeMarket,
  TapeSocketFactory,
  Venue,
} from './types';

/**
 * Wiring for the tape recorder: the Lighter and Binance feeds, the sampler,
 * the file sink, the gap log and the heartbeat. Every side effect is injected
 * (socket factory, clock, random, log, directory), so the lifecycle runs under
 * fake timers and a temp directory in tests. `scripts/ops/tape-recorder.ts`
 * wires the real ones.
 *
 * The recorder never touches MongoDB: its only state is the files under `dir`.
 *
 * GAPS. A lost connection, a stale watchdog, a resubscribe, a nonce break, a
 * sampler skip and a backpressure drop each write a line to gaps.jsonl when
 * the span ends (or, for a span still open at a clean shutdown, at shutdown).
 * A crash is covered at the next start: the gap runs from the previous
 * heartbeat to the new start, so it is over-stated and never missed.
 */

export interface TapeRecorderConfig {
  heartbeatEveryMs: number;
  shutdownFlushTimeoutMs: number;
  lighter: Partial<LighterFeedConfig>;
  binance: Partial<ConnectionConfig>;
  sampler: Partial<SamplerConfig>;
  sink: Partial<SinkConfig>;
}

export const DEFAULT_TAPE_RECORDER_CONFIG: TapeRecorderConfig = {
  heartbeatEveryMs: 60_000,
  shutdownFlushTimeoutMs: 20_000,
  lighter: {},
  binance: {},
  sampler: {},
  sink: {},
};

export interface TapeRecorderDeps {
  markets: TapeMarket[];
  dir: string;
  socketFactory: TapeSocketFactory;
  lighterUrl?: string;
  binanceUrl?: string;
  now?: () => number;
  random?: () => number;
  log?: LogFn;
  config?: Partial<TapeRecorderConfig>;
  /** Free-space probe for the disk floor. Injected in tests. */
  statfs?: (dir: string) => Promise<StatfsResult>;
}

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

export class TapeRecorder {
  private readonly cfg: TapeRecorderConfig;
  private readonly now: () => number;
  private readonly log: LogFn;
  readonly sink: TapeSink;
  readonly lighter: LighterFeed;
  readonly binance: BinanceFeed;
  private readonly sampler: Sampler;

  private tickTimer: Timer | null = null;
  private heartbeatTimer: Interval | null = null;
  private lastGap: GapRow | null = null;
  private rowsAtLastBeat = 0;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private lastLoad: {
    wall: number;
    cpu: number;
    elu: ReturnType<typeof performance.eventLoopUtilization>;
    lighterFrames: number;
    binanceFrames: number;
  } | null = null;

  constructor(private readonly deps: TapeRecorderDeps) {
    this.cfg = { ...DEFAULT_TAPE_RECORDER_CONFIG, ...deps.config };
    this.now = deps.now ?? (() => Date.now());
    this.log =
      deps.log ??
      ((event, fields) => console.log(JSON.stringify({ ts: new Date(this.now()).toISOString(), event, ...fields })));
    const onGap = (gap: GapReport) => this.reportGap(gap);

    this.sink = new TapeSink({ dir: deps.dir, now: this.now, log: this.log, onGap, config: this.cfg.sink, statfs: deps.statfs });
    this.lighter = new LighterFeed({
      markets: deps.markets,
      url: deps.lighterUrl ?? DEFAULT_LIGHTER_WS_URL,
      socketFactory: deps.socketFactory,
      now: this.now,
      random: deps.random,
      log: this.log,
      onGap,
      onTrade: (row) => {
        this.sink.write('lighter-trades', row.recv, row, false);
      },
      config: this.cfg.lighter,
    });
    this.binance = new BinanceFeed({
      markets: deps.markets,
      baseUrl: deps.binanceUrl ?? DEFAULT_BINANCE_WS_URL,
      socketFactory: deps.socketFactory,
      now: this.now,
      random: deps.random,
      log: this.log,
      onGap,
      config: this.cfg.binance,
    });
    this.sampler = new Sampler({
      coins: {
        lighter: deps.markets.map((m) => m.coin),
        binance: deps.markets.filter((m) => m.binanceSymbol !== null).map((m) => m.coin),
      },
      source: {
        quote: (venue: Venue, coin: string) =>
          venue === 'lighter' ? this.lighter.quote(coin) : this.binance.quote(coin),
      },
      emit: (stream: StreamName, row) => {
        this.sink.write(stream, row.t, row, stream.endsWith('burst'));
      },
      onGap,
      config: this.cfg.sampler,
    });
  }

  async start(): Promise<void> {
    const startedAt = this.now();
    const recovered = await this.sink.recoverStale();
    if (recovered.length > 0) this.log('recovered-tmp-files', { files: recovered });
    await this.sink.checkDisk();
    const previous = await this.sink.readHeartbeat();
    if (previous && previous.t < startedAt) {
      this.reportGap({ venue: 'tape', coin: null, reason: 'process-start', from: previous.t, to: startedAt });
    }
    this.log('starting', {
      markets: this.deps.markets.length,
      binanceSymbols: this.binance.symbolCount,
      dir: this.deps.dir,
    });
    if (this.stopping) return;

    this.sampler.start(this.now());
    this.lighter.start();
    this.binance.start();
    this.scheduleTick();
    this.heartbeatTimer = setInterval(() => this.heartbeat(false), this.cfg.heartbeatEveryMs);
    this.heartbeat(false);
  }

  /** Graceful stop: closes the feeds, emits the last due rows, closes gaps and files. Idempotent. */
  stop(signal: string): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.doStop(signal);
    return this.stopPromise;
  }

  // --- Internals -----------------------------------------------------------

  private reportGap(gap: GapReport): void {
    const row: GapRow = {
      t: this.now(),
      venue: gap.venue,
      coin: gap.coin,
      reason: gap.reason,
      from: gap.from,
      to: gap.to,
      ...(gap.stream ? { stream: gap.stream, file: gap.file } : {}),
    };
    this.lastGap = row;
    this.sink.appendGap(row);
    this.log('gap', { ...row });
  }

  private scheduleTick(): void {
    if (this.stopping) return;
    // Sleep until the next tick that emits a row (at most 1 s away), not every 100 ms.
    const delay = Math.max(1, this.sampler.nextDue - this.now());
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      const now = this.now();
      this.sampler.advance(now);
      this.sink.tick(now);
      this.scheduleTick();
    }, delay);
  }

  private heartbeat(stopped: boolean): void {
    const beat: Heartbeat = {
      t: this.now(),
      markets: this.deps.markets.length,
      lighterConnected: this.lighter.connected,
      binanceConnected: this.binance.connected,
      rowsLastMinute: this.sink.accepted - this.rowsAtLastBeat,
      lastGap: this.lastGap,
      droppedRows: this.sink.refused,
      diskFloor: this.sink.diskFloorActive,
      freeGb: this.sink.freeGb,
      stopped,
    };
    this.rowsAtLastBeat = this.sink.accepted;
    this.sink.writeHeartbeat(beat);
    if (!stopped) {
      this.log('heartbeat', {
        lighterConnected: beat.lighterConnected,
        binanceConnected: beat.binanceConnected,
        rowsLastMinute: beat.rowsLastMinute,
        droppedRows: beat.droppedRows,
        diskFloor: beat.diskFloor,
        freeGb: beat.freeGb,
        ...this.load(),
      });
    }
  }

  /**
   * Process load since the last heartbeat, for tuning on the host: CPU as a
   * share of one core (user + system), event-loop utilisation (the share of
   * time the JS thread was busy; the rest of the CPU is native I/O and zlib
   * threads), frames received and book levels held.
   */
  private load(): Record<string, unknown> {
    const wall = performance.now();
    const cpu = process.cpuUsage();
    const elu = performance.eventLoopUtilization();
    const prev = this.lastLoad;
    this.lastLoad = { wall, cpu: cpu.user + cpu.system, elu, lighterFrames: this.lighter.counters.frames, binanceFrames: this.binance.counters.frames };
    const lighterFrames = this.lighter.counters.frames - (prev?.lighterFrames ?? 0);
    const binanceFrames = this.binance.counters.frames - (prev?.binanceFrames ?? 0);
    const seconds = prev ? (wall - prev.wall) / 1000 : wall / 1000;
    const cpuMs = (cpu.user + cpu.system - (prev?.cpu ?? 0)) / 1000;
    const eluDelta = prev ? performance.eventLoopUtilization(elu, prev.elu) : elu;
    const levels = this.lighter.bookLevels().reduce((a, b) => a + b.bids + b.asks, 0);
    return {
      cpuPct: Math.round((cpuMs / 1000 / Math.max(seconds, 0.001)) * 1000) / 10,
      eluPct: Math.round(eluDelta.utilization * 1000) / 10,
      lighterFramesPerSec: Math.round(lighterFrames / Math.max(seconds, 0.001)),
      binanceFramesPerSec: Math.round(binanceFrames / Math.max(seconds, 0.001)),
      bookLevels: levels,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    };
  }

  private async doStop(signal: string): Promise<void> {
    this.stopping = true;
    this.log('stopping', { signal });
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    const now = this.now();
    try {
      this.sampler.advance(now);
    } catch {
      // start() had not run; there is nothing to emit.
    }
    // Spans still open at a clean shutdown end now.
    const lighterOpen = this.lighter.stop();
    if (lighterOpen) this.reportGap({ venue: 'lighter', coin: null, reason: lighterOpen.reason, from: lighterOpen.from, to: now });
    for (const m of this.lighter.unsyncedMarkets()) {
      this.reportGap({ venue: 'lighter', coin: m.coin, reason: m.reason, from: m.from, to: now });
    }
    const binanceOpen = this.binance.stop();
    if (binanceOpen) this.reportGap({ venue: 'binance', coin: null, reason: binanceOpen.reason, from: binanceOpen.from, to: now });

    this.heartbeat(true);
    let timer: Timer | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.log('shutdown-flush-timeout', {});
        resolve();
      }, this.cfg.shutdownFlushTimeoutMs);
    });
    await Promise.race([this.sink.closeAll(), timeout]);
    if (timer) clearTimeout(timer);
    this.log('stopped', { accepted: this.sink.accepted, dropped: this.sink.dropped, late: this.sink.late, diskDropped: this.sink.diskDropped });
  }
}
