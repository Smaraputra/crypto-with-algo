import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import zlib from 'node:zlib';

import type { GapReport, GapRow, Heartbeat, LogFn, StreamName } from './types';

/**
 * Hourly gzip JSON Lines files under `<dir>/YYYY-MM-DD/<stream>-HH.jsonl.gz`
 * (UTC), plus the append-only `gaps.jsonl` and the rewritten `heartbeat.json`
 * in `<dir>`.
 *
 * FILES. A file is written as `<final>.<bootMs>.tmp` and published when its
 * hour closes (`lateGraceMs` after the hour ends, so a row stamped 13:59:59.9
 * and produced a moment later still lands in hour 13) or on `closeAll`.
 * Publishing never overwrites or modifies an existing file: it hard-links the
 * tmp file to the first free name of `<stream>-HH.jsonl.gz`,
 * `<stream>-HH.part2.jsonl.gz`, `.part3`, ... (a restart inside the hour
 * makes part 2), then removes the tmp name. Each part is a complete gzip
 * stream. Rows are handed to gzip in batches (every `pushEveryMs` or
 * `pushBytes`), which keeps the number of zlib jobs per second low, and the
 * gzip stream gets a sync flush every `flushEveryMs`, so a crash loses seconds,
 * not the hour. `.tmp` files left by a crash are renamed `<name>.crashed-<ms>`
 * at start, in every dated folder; they are truncated gzip streams.
 *
 * WRITE ERRORS. A write error (disk full, I/O error) marks the stream
 * failed the moment it happens: the stream is destroyed, later rows for it are
 * dropped and counted, and at its close the tmp file is renamed
 * `<final>.failed-<ms>` (never published, never merged into a good file) and a
 * `write-error` gap line is written, from the first row of that stream to the
 * close, because none of its rows are published. `closeAll` always resolves.
 * `.failed` and `.crashed` files are not published data (see GapRow in
 * types.ts). At start, a leftover `.tmp` (a crash) is renamed `.crashed-<ms>`
 * with a `crashed-file` gap line, unless its link count is above 1, which means
 * a crash between link and unlink: the data is already published under the
 * final name and the leftover name is just removed.
 *
 * CLOSED HOURS. Once a stream has begun closing, its (stream, hour) key is
 * remembered and a later row for it (a backward clock step, say) is refused,
 * with one `late-row` gap line, rather than opening a second stream. Every open
 * gets its own tmp name (boot time and a sequence number), so two opens can
 * never share a path.
 *
 * BACKPRESSURE. Rows are only queued in memory while a stream can take them.
 * Past `softLimitBytes` buffered in one stream, droppable rows (burst) are
 * dropped; past `hardLimitBytes` every row is. A drop episode is reported once,
 * when rows are accepted again, as a `backpressure` gap.
 *
 * DISK FLOOR. The volume is shared with other services. Free space is read
 * with statfs before the first write, once a minute and when a new hour file
 * opens. Below `minFreeBytes` no row is written (the feeds stay connected),
 * and when space returns (5% above the floor) one `disk-floor` gap line is
 * written for the span. The state is in the heartbeat.
 */

const HOUR_MS = 3_600_000;

export interface SinkConfig {
  lateGraceMs: number;
  flushEveryMs: number;
  /** Rows are pushed into gzip when this old, or when `pushBytes` are pending. */
  pushEveryMs: number;
  pushBytes: number;
  softLimitBytes: number;
  hardLimitBytes: number;
  gzipLevel: number;
  /** Free space below this stops all writing. 0 disables the floor. */
  minFreeBytes: number;
  diskCheckEveryMs: number;
  /** A stream that has not closed this long after `end` is treated as failed. */
  closeTimeoutMs: number;
}

export const DEFAULT_SINK_CONFIG: SinkConfig = {
  lateGraceMs: 15_000,
  flushEveryMs: 10_000,
  pushEveryMs: 250,
  pushBytes: 64 * 1024,
  softLimitBytes: 4 * 1024 * 1024,
  hardLimitBytes: 16 * 1024 * 1024,
  gzipLevel: 6,
  minFreeBytes: 10 * 1024 ** 3,
  diskCheckEveryMs: 60_000,
  closeTimeoutMs: 15_000,
};

export interface StatfsResult {
  bavail: number | bigint;
  bsize: number | bigint;
}

export interface SinkDeps {
  dir: string;
  now: () => number;
  log: LogFn;
  onGap(gap: GapReport): void;
  config?: Partial<SinkConfig>;
  /** Opens the tmp file for writing. Injected in tests to fail on demand. */
  openFile?: (file: string) => Writable;
  /** Free space probe. Injected in tests. */
  statfs?: (dir: string) => Promise<StatfsResult>;
}

interface OpenStream {
  name: StreamName;
  hourStart: number;
  tmpPath: string;
  finalPath: string;
  gz: zlib.Gzip | null;
  out: Writable | null;
  pending: string;
  lastPushAt: number;
  ending: boolean;
  /** Timestamp of the earliest row accepted into this stream. */
  firstRowTs: number | null;
  failure: { at: number; message: string } | null;
  /** Resolves when the file is closed or the stream died. Created with the stream. */
  closed: Promise<void>;
  dropStart: number | null;
  dropped: number;
}

export function hourFilePath(dir: string, name: StreamName, hourStart: number): string {
  const iso = new Date(hourStart).toISOString();
  return path.join(dir, iso.slice(0, 10), `${name}-${iso.slice(11, 13)}.jsonl.gz`);
}

/** `x-12.jsonl.gz` -> `x-12.part2.jsonl.gz`. */
export function partFilePath(finalPath: string, part: number): string {
  return part <= 1 ? finalPath : finalPath.replace(/\.jsonl\.gz$/, `.part${part}.jsonl.gz`);
}

export class TapeSink {
  private readonly cfg: SinkConfig;
  private readonly open = new Map<string, OpenStream>();
  private readonly closing = new Set<Promise<void>>();
  private readonly bootMs: number;
  private fileChain: Promise<void> = Promise.resolve();
  private lastFlushAt = 0;
  private errorsLogged = 0;
  private openSeq = 0;
  /** (stream, hour) keys that have begun closing, with the hour start, and those already reported. */
  private readonly closedKeys = new Map<string, number>();
  private readonly lateReported = new Set<string>();

  private diskOk = true;
  private diskFloorSince: number | null = null;
  private freeBytes: number | null = null;
  private lastDiskCheckAt = -Infinity;
  private diskChecking: Promise<void> | null = null;

  accepted = 0;
  /** Rows refused by backpressure or because their stream failed. */
  dropped = 0;
  /** Rows refused because their hour file was already closed. */
  late = 0;
  /** Rows refused while free space was below the floor. */
  diskDropped = 0;

  constructor(private readonly deps: SinkDeps) {
    this.cfg = { ...DEFAULT_SINK_CONFIG, ...deps.config };
    this.bootMs = deps.now();
    this.lastFlushAt = this.bootMs;
  }

  get diskFloorActive(): boolean {
    return !this.diskOk;
  }

  get freeGb(): number | null {
    return this.freeBytes === null ? null : Math.round((this.freeBytes / 1024 ** 3) * 100) / 100;
  }

  /** Rows refused for any reason. */
  get refused(): number {
    return this.dropped + this.late + this.diskDropped;
  }

  private relative(file: string): string {
    return path.relative(this.deps.dir, file).split(path.sep).join('/');
  }

  /**
   * Handles `.tmp` files a crashed process left behind, in every dated folder.
   * Call before any write. A tmp file with a link count above 1 is the
   * remnant of a crash between link and unlink: its data is already published,
   * so the name is removed and no gap is written. Any other tmp file is renamed
   * `<name>.crashed-<ms>` and a `crashed-file` gap line covers the hour it
   * held: from its first readable row (else the hour start) to the earlier of
   * the previous heartbeat and the hour end. Old `.merge` leftovers are renamed
   * without a gap.
   */
  async recoverStale(): Promise<string[]> {
    const now = this.deps.now();
    const recovered: string[] = [];
    let days: string[];
    try {
      days = (await fs.promises.readdir(this.deps.dir)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
    } catch {
      return recovered;
    }
    const previousBeat = days.length > 0 ? await this.readHeartbeat() : null;
    for (const day of days) {
      const folder = path.join(this.deps.dir, day);
      let names: string[];
      try {
        names = await fs.promises.readdir(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        const isTmp = name.endsWith('.tmp');
        if (!isTmp && !name.endsWith('.merge')) continue;
        const from = path.join(folder, name);
        try {
          if (isTmp && (await fs.promises.stat(from)).nlink > 1) {
            await fs.promises.unlink(from);
            this.deps.log('recover-unlinked-published', { file: from });
            continue;
          }
          const to = `${from.replace(/\.(tmp|merge)$/, '')}.crashed-${now}`;
          await fs.promises.rename(from, to);
          recovered.push(to);
          if (isTmp) await this.reportCrashedFile(day, name, to, previousBeat?.t ?? null);
        } catch (err) {
          this.deps.log('recover-error', { file: from, error: errorText(err) });
        }
      }
    }
    return recovered;
  }

  private async reportCrashedFile(day: string, name: string, crashed: string, beatT: number | null): Promise<void> {
    const m = STREAM_FILE.exec(name);
    if (!m) return;
    const stream = m[1] as StreamName;
    const hourStart = Date.parse(`${day}T${m[2]}:00:00.000Z`);
    if (!Number.isFinite(hourStart)) return;
    const hourEnd = hourStart + HOUR_MS;
    const first = (await this.firstRowTime(crashed)) ?? hourStart;
    const from = Math.max(hourStart, Math.min(first, hourEnd));
    const to = Math.max(from, Math.min(beatT ?? hourEnd, hourEnd));
    this.deps.onGap({
      venue: venueOf(stream),
      coin: null,
      reason: 'crashed-file',
      from,
      to,
      stream,
      file: this.relative(crashed),
    });
  }

  /** The `t` of the first row of a (possibly truncated) gzip file, or null if it cannot be read cheaply. */
  private async firstRowTime(file: string): Promise<number | null> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(file, 'r');
      const buf = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) return null;
      const text = zlib.gunzipSync(buf.subarray(0, bytesRead), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
      const line = text.split('\n')[0];
      if (!line) return null;
      const t = (JSON.parse(line) as { t?: unknown }).t;
      return typeof t === 'number' && Number.isFinite(t) ? t : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Reads free space and updates the disk-floor state. Never throws. */
  checkDisk(): Promise<void> {
    if (this.diskChecking) return this.diskChecking;
    this.lastDiskCheckAt = this.deps.now();
    this.diskChecking = this.doCheckDisk().finally(() => {
      this.diskChecking = null;
    });
    return this.diskChecking;
  }

  private async doCheckDisk(): Promise<void> {
    if (this.cfg.minFreeBytes <= 0) return;
    let free: number;
    try {
      await fs.promises.mkdir(this.deps.dir, { recursive: true });
      const probe = this.deps.statfs ?? ((d: string) => fs.promises.statfs(d));
      const st = await probe(this.deps.dir);
      free = Number(st.bavail) * Number(st.bsize);
      if (!Number.isFinite(free)) throw new Error('statfs returned a non-number');
    } catch (err) {
      // Keep the previous state: a failed probe is not a reason to start or stop writing.
      if (this.errorsLogged++ < 20) this.deps.log('statfs-error', { error: errorText(err) });
      return;
    }
    const now = this.deps.now();
    this.freeBytes = free;
    if (this.diskOk && free < this.cfg.minFreeBytes) {
      this.diskOk = false;
      this.diskFloorSince = now;
      this.deps.log('disk-floor-start', { freeGb: this.freeGb, floorGb: this.cfg.minFreeBytes / 1024 ** 3 });
    } else if (!this.diskOk && free >= this.cfg.minFreeBytes * 1.05) {
      this.endDiskFloor(now);
    }
  }

  private endDiskFloor(now: number): void {
    const from = this.diskFloorSince ?? now;
    this.diskOk = true;
    this.diskFloorSince = null;
    this.deps.log('disk-floor-over', { freeGb: this.freeGb, rowsRefused: this.diskDropped });
    this.deps.onGap({ venue: 'tape', coin: null, reason: 'disk-floor', from, to: now });
  }

  /**
   * Queues one row. `ts` picks the hour file (the sample boundary for quote
   * rows, the receive time for trades). Returns false when the row was refused.
   */
  write(name: StreamName, ts: number, row: object, droppable: boolean): boolean {
    const now = this.deps.now();
    if (!this.diskOk) {
      this.diskDropped++;
      return false;
    }
    const hourStart = Math.floor(ts / HOUR_MS) * HOUR_MS;
    if (hourStart + HOUR_MS + this.cfg.lateGraceMs <= now) {
      this.late++;
      return false;
    }
    const key = `${name}|${hourStart}`;
    if (this.closedKeys.has(key)) {
      this.late++;
      if (!this.lateReported.has(key)) {
        this.lateReported.add(key);
        this.deps.onGap({
          venue: venueOf(name),
          coin: null,
          reason: 'late-row',
          from: ts,
          to: now,
          stream: name,
          file: this.relative(hourFilePath(this.deps.dir, name, hourStart)),
        });
      }
      return false;
    }
    const stream = this.openStream(name, hourStart, now);
    if (stream.failure || !stream.gz || !stream.out) {
      this.dropped++;
      return false;
    }
    const buffered =
      stream.pending.length + stream.gz.writableLength + stream.gz.readableLength + stream.out.writableLength;
    if (buffered >= this.cfg.hardLimitBytes || (droppable && buffered >= this.cfg.softLimitBytes)) {
      this.dropped++;
      stream.dropped++;
      if (stream.dropStart === null) {
        stream.dropStart = now;
        this.deps.log('backpressure-start', { stream: name });
      }
      return false;
    }
    if (stream.dropStart !== null) {
      this.deps.onGap({ venue: venueOf(name), coin: null, reason: 'backpressure', from: stream.dropStart, to: now });
      this.deps.log('backpressure-over', { stream: name, dropped: stream.dropped });
      stream.dropStart = null;
      stream.dropped = 0;
    }
    stream.pending += `${JSON.stringify(row)}\n`;
    if (stream.firstRowTs === null || ts < stream.firstRowTs) stream.firstRowTs = ts;
    this.accepted++;
    if (stream.pending.length >= this.cfg.pushBytes) this.push(stream, now);
    return true;
  }

  /** Pushes due batches, closes streams whose hour is over, sync-flushes on a schedule, checks the disk. */
  tick(now: number): void {
    for (const stream of this.open.values()) {
      if (!stream.ending && stream.pending && now - stream.lastPushAt >= this.cfg.pushEveryMs) this.push(stream, now);
    }
    for (const stream of [...this.open.values()]) {
      if (!stream.ending && stream.hourStart + HOUR_MS + this.cfg.lateGraceMs <= now) this.beginClose(stream);
    }
    for (const [key, hourStart] of this.closedKeys) {
      if (hourStart + 2 * HOUR_MS + this.cfg.lateGraceMs <= now) {
        this.closedKeys.delete(key);
        this.lateReported.delete(key);
      }
    }
    if (now - this.lastFlushAt >= this.cfg.flushEveryMs) {
      this.lastFlushAt = now;
      for (const stream of this.open.values()) {
        if (!stream.ending && !stream.failure) stream.gz?.flush(zlib.constants.Z_SYNC_FLUSH);
      }
    }
    if (now - this.lastDiskCheckAt >= this.cfg.diskCheckEveryMs) void this.checkDisk();
  }

  /** Closes and publishes every open file, and waits for the gap and heartbeat writes. Always resolves. */
  async closeAll(): Promise<void> {
    for (const stream of [...this.open.values()]) if (!stream.ending) this.beginClose(stream);
    await Promise.all([...this.closing]);
    if (!this.diskOk && this.diskFloorSince !== null) {
      // The span is still open at shutdown: report it up to now.
      const now = this.deps.now();
      this.deps.onGap({ venue: 'tape', coin: null, reason: 'disk-floor', from: this.diskFloorSince, to: now });
      this.diskFloorSince = now;
    }
    await this.fileChain;
  }

  /** Appends one line to gaps.jsonl (not gzipped). */
  appendGap(gap: GapRow): void {
    const file = path.join(this.deps.dir, 'gaps.jsonl');
    this.enqueueFile(async () => {
      await fs.promises.mkdir(this.deps.dir, { recursive: true });
      await fs.promises.appendFile(file, `${JSON.stringify(gap)}\n`);
    }, 'gap-write-error');
  }

  /** Rewrites heartbeat.json atomically. */
  writeHeartbeat(heartbeat: Heartbeat): void {
    const file = path.join(this.deps.dir, 'heartbeat.json');
    this.enqueueFile(async () => {
      await fs.promises.mkdir(this.deps.dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(heartbeat));
      await fs.promises.rename(tmp, file);
    }, 'heartbeat-write-error');
  }

  /** The previous process's last heartbeat, or null when absent or unreadable. */
  async readHeartbeat(): Promise<Heartbeat | null> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(this.deps.dir, 'heartbeat.json'), 'utf8')) as Heartbeat;
      return typeof parsed.t === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  // --- Internals -----------------------------------------------------------

  private enqueueFile(task: () => Promise<void>, event: string): void {
    this.fileChain = this.fileChain.then(task).catch((err) => {
      if (this.errorsLogged++ < 20) this.deps.log(event, { error: errorText(err) });
    });
  }

  private push(stream: OpenStream, now: number): void {
    if (!stream.pending || !stream.gz || stream.failure) return;
    const text = stream.pending;
    stream.pending = '';
    stream.lastPushAt = now;
    stream.gz.write(text);
  }

  private openStream(name: StreamName, hourStart: number, now: number): OpenStream {
    const key = `${name}|${hourStart}`;
    const existing = this.open.get(key);
    if (existing) return existing;
    // A new hour file: refresh the free-space reading (used from the next row on).
    if (now - this.lastDiskCheckAt > 5_000) void this.checkDisk();

    const finalPath = hourFilePath(this.deps.dir, name, hourStart);
    let resolveClosed: () => void = () => undefined;
    const stream: OpenStream = {
      name,
      hourStart,
      tmpPath: `${finalPath}.${this.bootMs}.${++this.openSeq}.tmp`,
      finalPath,
      gz: null,
      out: null,
      pending: '',
      lastPushAt: now,
      ending: false,
      firstRowTs: null,
      failure: null,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      dropStart: null,
      dropped: 0,
    };
    this.open.set(key, stream);
    try {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      const out = this.deps.openFile ? this.deps.openFile(stream.tmpPath) : fs.createWriteStream(stream.tmpPath);
      const gz = zlib.createGzip({ level: this.cfg.gzipLevel });
      // Listeners go on at creation, so an error or close at any moment is seen.
      const fail = (err: unknown) => this.fail(stream, err);
      out.on('error', fail);
      gz.on('error', fail);
      out.on('close', () => {
        if (!stream.ending && !stream.failure) this.fail(stream, new Error('output closed early'));
        resolveClosed();
      });
      gz.pipe(out);
      stream.out = out;
      stream.gz = gz;
    } catch (err) {
      this.fail(stream, err);
      resolveClosed();
    }
    return stream;
  }

  private fail(stream: OpenStream, err: unknown): void {
    if (!stream.failure) {
      stream.failure = { at: this.deps.now(), message: errorText(err) };
      stream.pending = '';
      if (this.errorsLogged++ < 20) this.deps.log('sink-error', { file: stream.tmpPath, error: stream.failure.message });
    }
    stream.gz?.unpipe();
    stream.gz?.destroy();
    stream.out?.destroy();
  }

  private beginClose(stream: OpenStream): void {
    const key = `${stream.name}|${stream.hourStart}`;
    this.open.delete(key);
    this.closedKeys.set(key, stream.hourStart);
    stream.ending = true;
    const promise = this.finish(stream)
      .catch((err) => this.deps.log('sink-close-error', { file: stream.tmpPath, error: errorText(err) }))
      .finally(() => this.closing.delete(promise));
    this.closing.add(promise);
  }

  private async finish(stream: OpenStream): Promise<void> {
    if (stream.dropStart !== null) {
      this.deps.onGap({ venue: venueOf(stream.name), coin: null, reason: 'backpressure', from: stream.dropStart, to: this.deps.now() });
      stream.dropStart = null;
    }
    if (!stream.failure && stream.gz) {
      if (stream.pending) this.push(stream, this.deps.now());
      stream.gz.end();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.cfg.closeTimeoutMs);
    });
    const outcome = await Promise.race([stream.closed.then(() => 'closed' as const), timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout' && !stream.failure) this.fail(stream, new Error('close timed out'));

    if (stream.failure) {
      await this.quarantine(stream);
      return;
    }
    try {
      const target = await this.publish(stream);
      if (target !== stream.finalPath) this.deps.log('part-file', { file: target });
    } catch (err) {
      this.deps.log('sink-rename-error', { file: stream.tmpPath, error: errorText(err) });
    }
  }

  /** A failed stream's file is never published: it is kept as `.failed-<ms>` and the span is reported. */
  private async quarantine(stream: OpenStream): Promise<void> {
    const now = this.deps.now();
    const failure = stream.failure as { at: number; message: string };
    let kept: string | null = null;
    try {
      const to = `${stream.finalPath}.failed-${now}`;
      await fs.promises.rename(stream.tmpPath, to);
      kept = to;
    } catch {
      // Nothing was written, or the file is gone.
    }
    this.deps.log('stream-failed', { file: stream.finalPath, error: failure.message, kept });
    // None of this stream's rows are published, so the span starts at its first row, not at the failure.
    this.deps.onGap({
      venue: venueOf(stream.name),
      coin: null,
      reason: 'write-error',
      from: Math.min(stream.firstRowTs ?? failure.at, failure.at),
      to: now,
      stream: stream.name,
      file: this.relative(kept ?? `${stream.finalPath}.failed-${now}`),
    });
  }

  /** Hard-links tmp to the first free `-HH`, `-HH.part2`, ... name and removes the tmp name. Never overwrites. */
  private async publish(stream: OpenStream): Promise<string> {
    try {
      await fs.promises.stat(stream.tmpPath);
    } catch {
      return stream.finalPath;
    }
    for (let part = 1; part < 1_000; part++) {
      const target = partFilePath(stream.finalPath, part);
      try {
        await fs.promises.link(stream.tmpPath, target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        // A filesystem without hard links: fall back to a checked rename.
        let exists = true;
        try {
          await fs.promises.stat(target);
        } catch {
          exists = false;
        }
        if (exists) continue;
        await fs.promises.rename(stream.tmpPath, target);
        return target;
      }
      await fs.promises.unlink(stream.tmpPath);
      return target;
    }
    throw new Error(`no free part name for ${stream.finalPath}`);
  }
}

const STREAM_FILE = /^(lighter-1s|binance-1s|lighter-burst|binance-burst|lighter-trades)-(\d{2})\.jsonl\.gz\b/;

function venueOf(name: StreamName): 'lighter' | 'binance' {
  return name.startsWith('binance') ? 'binance' : 'lighter';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
