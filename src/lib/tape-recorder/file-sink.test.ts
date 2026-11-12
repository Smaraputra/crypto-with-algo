// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hourFilePath, partFilePath, TapeSink, type SinkConfig, type SinkDeps } from './file-sink';
import type { GapReport, GapRow, Heartbeat } from './types';

const H12 = Date.UTC(2026, 10, 11, 12, 0, 0);
const HOUR = 3_600_000;

let dir: string;
let now: number;
let gaps: GapReport[];
let logs: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-sink-'));
  now = H12 + 5_000;
  gaps = [];
  logs = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sink(config: Partial<SinkConfig> = {}, d = dir, extra: Partial<SinkDeps> = {}): TapeSink {
  return new TapeSink({
    dir: d,
    now: () => now,
    log: (e) => logs.push(e),
    onGap: (g) => gaps.push(g),
    // The real disk is not what these tests are about.
    config: { minFreeBytes: 0, ...config },
    ...extra,
  });
}

/** A file that writes half of what it is given and then fails, like a disk that fills mid-write. */
class FailingFile extends Writable {
  private writes = 0;

  constructor(
    private readonly file: string,
    private readonly okWrites = 0
  ) {
    super();
    fs.writeFileSync(file, '');
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.writes++ < this.okWrites) {
      fs.appendFileSync(this.file, chunk);
      cb();
      return;
    }
    fs.appendFileSync(this.file, chunk.subarray(0, Math.max(1, Math.floor(chunk.length / 2))));
    cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
  }
}

const failing = (okWrites = 0) => ({ openFile: (f: string) => new FailingFile(f, okWrites) });

const names = (day = '2026-11-11') => fs.readdirSync(path.join(dir, day)).sort();

function readRows(file: string): Array<Record<string, unknown>> {
  return zlib
    .gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const file = (name: Parameters<typeof hourFilePath>[1], hour: number) => hourFilePath(dir, name, hour);

describe('TapeSink files', () => {
  it('names files by UTC date and hour', () => {
    expect(file('lighter-1s', H12)).toBe(path.join(dir, '2026-11-11', 'lighter-1s-12.jsonl.gz'));
    expect(file('binance-burst', H12 + 13 * HOUR)).toBe(path.join(dir, '2026-11-12', 'binance-burst-01.jsonl.gz'));
  });

  it('writes to a .tmp file while open and renames it on close, rows intact', async () => {
    const s = sink();
    expect(s.write('lighter-1s', H12 + 1_000, { t: H12 + 1_000, coin: 'BTC', bid: 1.5, ok: true }, false)).toBe(true);
    expect(s.write('lighter-1s', H12 + 2_000, { t: H12 + 2_000, coin: 'BTC', bid: null, ok: false }, false)).toBe(true);
    await until(() => fs.existsSync(path.join(dir, '2026-11-11')) && names().some((n) => n.endsWith('.tmp')));
    expect(fs.existsSync(file('lighter-1s', H12))).toBe(false);

    await s.closeAll();
    expect(names()).toEqual(['lighter-1s-12.jsonl.gz']);
    expect(readRows(file('lighter-1s', H12))).toEqual([
      { t: H12 + 1_000, coin: 'BTC', bid: 1.5, ok: true },
      { t: H12 + 2_000, coin: 'BTC', bid: null, ok: false },
    ]);
    expect(s.accepted).toBe(2);
  });

  it('keeps one file per stream and hour', async () => {
    const s = sink();
    s.write('lighter-1s', H12, { n: 1 }, false);
    s.write('binance-1s', H12, { n: 2 }, false);
    s.write('lighter-trades', H12, { n: 3 }, false);
    s.write('lighter-burst', H12, { n: 4 }, true);
    s.write('binance-burst', H12, { n: 5 }, true);
    await s.closeAll();
    expect(names()).toEqual([
      'binance-1s-12.jsonl.gz',
      'binance-burst-12.jsonl.gz',
      'lighter-1s-12.jsonl.gz',
      'lighter-burst-12.jsonl.gz',
      'lighter-trades-12.jsonl.gz',
    ]);
  });

  it('rotates when the hour closes, after the grace, and starts the next hour file', async () => {
    const s = sink({ lateGraceMs: 10_000 });
    s.write('lighter-1s', H12 + HOUR - 1_000, { n: 1 }, false);
    // Hour 12 ended, but a row stamped inside it that is produced late still lands there.
    now = H12 + HOUR + 50;
    expect(s.write('lighter-1s', H12 + HOUR - 100, { n: 2 }, false)).toBe(true);
    s.write('lighter-1s', H12 + HOUR, { n: 3 }, false);
    s.tick(now);
    expect(fs.existsSync(file('lighter-1s', H12))).toBe(false);

    now = H12 + HOUR + 10_000;
    s.tick(now);
    await until(() => fs.existsSync(file('lighter-1s', H12)));
    expect(readRows(file('lighter-1s', H12))).toEqual([{ n: 1 }, { n: 2 }]);

    // Past the grace, a row for the closed hour is refused and counted.
    expect(s.write('lighter-1s', H12 + HOUR - 50, { n: 4 }, false)).toBe(false);
    expect(s.late).toBe(1);

    await s.closeAll();
    expect(readRows(file('lighter-1s', H12 + HOUR))).toEqual([{ n: 3 }]);
  });

  it('writes a restart inside the same hour as its own part file and leaves the first untouched', async () => {
    const first = sink();
    first.write('lighter-1s', H12 + 1_000, { n: 1 }, false);
    first.write('lighter-1s', H12 + 2_000, { n: 2 }, false);
    await first.closeAll();
    const before = fs.readFileSync(file('lighter-1s', H12));

    now += 1_000;
    const second = sink();
    second.write('lighter-1s', H12 + 9_000, { n: 3 }, false);
    await second.closeAll();
    now += 1_000;
    const third = sink();
    third.write('lighter-1s', H12 + 9_500, { n: 4 }, false);
    await third.closeAll();

    expect(names()).toEqual(['lighter-1s-12.jsonl.gz', 'lighter-1s-12.part2.jsonl.gz', 'lighter-1s-12.part3.jsonl.gz']);
    expect(fs.readFileSync(file('lighter-1s', H12)).equals(before)).toBe(true);
    expect(readRows(file('lighter-1s', H12))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(readRows(partFilePath(file('lighter-1s', H12), 2))).toEqual([{ n: 3 }]);
    expect(readRows(partFilePath(file('lighter-1s', H12), 3))).toEqual([{ n: 4 }]);
  });

  it('sync-flushes the open gzip stream so a crash loses seconds, not the hour', async () => {
    const s = sink({ flushEveryMs: 1_000 });
    s.write('lighter-1s', H12, { n: 1 }, false);
    now += 1_000;
    s.tick(now);
    const tmp = () => path.join(dir, '2026-11-11', names().find((n) => n.endsWith('.tmp')) ?? 'none');
    await until(() => fs.existsSync(tmp()) && fs.statSync(tmp()).size > 10);
    // A truncated gzip stream still yields the flushed rows.
    const partial = zlib.gunzipSync(fs.readFileSync(tmp()), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    expect(partial.trim()).toBe('{"n":1}');
    await s.closeAll();
  });

  it('renames .tmp files a crashed process left behind, in every dated folder', async () => {
    const old = path.join(dir, '2026-09-01');
    const day = path.join(dir, '2026-11-11');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(old, 'lighter-1s-03.jsonl.gz.1700.tmp'), 'partial');
    fs.writeFileSync(path.join(day, 'lighter-1s-11.jsonl.gz.1800.tmp'), 'partial');
    fs.writeFileSync(path.join(day, 'lighter-1s-09.jsonl.gz.merge'), 'old merge leftover');
    fs.writeFileSync(path.join(day, 'lighter-1s-10.jsonl.gz'), 'fine');
    fs.writeFileSync(path.join(dir, 'not-a-day.tmp'), 'ignored');
    const recovered = await sink().recoverStale();
    expect(recovered).toHaveLength(3);
    expect(fs.readdirSync(old)).toEqual([`lighter-1s-03.jsonl.gz.1700.crashed-${now}`]);
    expect(fs.readdirSync(day).sort()).toEqual([
      'lighter-1s-10.jsonl.gz',
      `lighter-1s-11.jsonl.gz.1800.crashed-${now}`,
      `lighter-1s-09.jsonl.gz.crashed-${now}`,
    ].sort());
    expect(fs.existsSync(path.join(dir, 'not-a-day.tmp'))).toBe(true);
  });

  it('does not collide with a leftover tmp file from a crashed process', async () => {
    const first = sink({}, dir);
    first.write('lighter-1s', H12, { n: 1 }, false);
    await until(() => fs.existsSync(path.join(dir, '2026-11-11')) && names().some((n) => n.endsWith('.tmp')));
    // The first process "crashes": no close. A later process starts, one second on.
    now += 1_000;
    const crashedTmp = names().find((n) => n.endsWith('.tmp')) as string;
    const second = sink();
    second.write('lighter-1s', H12 + 1_000, { n: 2 }, false);
    await second.closeAll();
    expect(names()).toContain(crashedTmp);
    expect(readRows(file('lighter-1s', H12))).toEqual([{ n: 2 }]);
    await first.closeAll();
  });
});

describe('TapeSink backpressure', () => {
  it('drops droppable rows past the soft limit, keeps normal rows, and logs one gap when it clears', async () => {
    const s = sink({ softLimitBytes: 1, hardLimitBytes: 1e9 });
    expect(s.write('lighter-burst', H12, { n: 1 }, true)).toBe(true);
    // The first row is still buffered in the gzip stream.
    expect(s.write('lighter-burst', H12, { n: 2 }, true)).toBe(false);
    expect(s.write('lighter-burst', H12, { n: 3 }, true)).toBe(false);
    // Normal rows (1 s rows, prints) are not subject to the soft limit.
    expect(s.write('lighter-1s', H12, { n: 4 }, false)).toBe(true);
    expect(s.write('lighter-1s', H12, { n: 6 }, false)).toBe(true);
    expect(s.dropped).toBe(2);
    expect(gaps).toEqual([]);

    now += 1_000;
    s.tick(now);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.write('lighter-burst', H12, { n: 5 }, true)).toBe(true);
    expect(gaps).toEqual([{ venue: 'lighter', coin: null, reason: 'backpressure', from: H12 + 5_000, to: H12 + 6_000 }]);
    await s.closeAll();
    expect(readRows(file('lighter-burst', H12))).toEqual([{ n: 1 }, { n: 5 }]);
    expect(readRows(file('lighter-1s', H12))).toEqual([{ n: 4 }, { n: 6 }]);
  });

  it('drops every row past the hard limit', async () => {
    const s = sink({ softLimitBytes: 1, hardLimitBytes: 1 });
    expect(s.write('binance-1s', H12, { n: 1 }, false)).toBe(true);
    expect(s.write('binance-1s', H12, { n: 2 }, false)).toBe(false);
    await s.closeAll();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ venue: 'binance', reason: 'backpressure' });
  });

  it('survives an unwritable folder by dropping rows', async () => {
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const s = sink({}, path.join(blocker, 'sub'));
    expect(s.write('lighter-1s', H12, { n: 1 }, false)).toBe(false);
    expect(s.dropped).toBe(1);
    expect(logs).toContain('sink-error');
    await expect(s.closeAll()).resolves.toBeUndefined();
  });
});

describe('TapeSink gap log and heartbeat', () => {
  it('appends gap lines and never gzips them', async () => {
    const s = sink();
    const a: GapRow = { t: 1, venue: 'lighter', coin: null, reason: 'disconnect', from: 0, to: 1 };
    const b: GapRow = { t: 2, venue: 'lighter', coin: 'BTC', reason: 'nonce-break', from: 1, to: 2 };
    s.appendGap(a);
    s.appendGap(b);
    await s.closeAll();
    const lines = fs.readFileSync(path.join(dir, 'gaps.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([a, b]);
  });

  it('rewrites heartbeat.json atomically and reads it back', async () => {
    const s = sink();
    expect(await s.readHeartbeat()).toBeNull();
    const beat: Heartbeat = {
      t: H12,
      markets: 2,
      lighterConnected: true,
      binanceConnected: false,
      rowsLastMinute: 120,
      lastGap: null,
      droppedRows: 0,
      diskFloor: false,
      freeGb: 42.5,
      stopped: false,
    };
    s.writeHeartbeat(beat);
    s.writeHeartbeat({ ...beat, t: H12 + 60_000, rowsLastMinute: 130 });
    await s.closeAll();
    expect(await s.readHeartbeat()).toMatchObject({ t: H12 + 60_000, rowsLastMinute: 130 });
    expect(fs.readdirSync(dir)).toEqual(['heartbeat.json']);
  });
});

describe('TapeSink write errors', () => {
  const failedFiles = (day = '2026-11-11') => names(day).filter((n) => n.includes('.failed-'));

  it('A: an error during the close flush publishes nothing and closeAll resolves', async () => {
    const s = sink({}, dir, failing());
    s.write('lighter-1s', H12 + 1_000, { n: 1 }, false);
    s.write('lighter-1s', H12 + 2_000, { n: 2 }, false);
    now += 60_000;
    await s.closeAll();
    expect(names().filter((n) => n.endsWith('.jsonl.gz'))).toEqual([]);
    expect(failedFiles()).toHaveLength(1);
    expect(names().some((n) => n.endsWith('.tmp'))).toBe(false);
    // None of the stream's rows are published, so the gap runs from its first row to the close.
    expect(gaps).toEqual([
      {
        venue: 'lighter',
        coin: null,
        reason: 'write-error',
        from: H12 + 1_000,
        to: H12 + 65_000,
        stream: 'lighter-1s',
        file: `2026-11-11/lighter-1s-12.jsonl.gz.failed-${H12 + 65_000}`,
      },
    ]);
    expect(fs.existsSync(path.join(dir, gaps[0].file as string))).toBe(true);
    expect(logs).toContain('sink-error');
    expect(logs).toContain('stream-failed');
    // The file really is a truncated gzip stream: it must not have been given the final name.
    expect(() => zlib.gunzipSync(fs.readFileSync(path.join(dir, '2026-11-11', failedFiles()[0])))).toThrow();
  });

  it('B: a failed second run in the same hour leaves the good first file byte for byte', async () => {
    const good = sink();
    good.write('lighter-1s', H12 + 1_000, { n: 1 }, false);
    await good.closeAll();
    const before = fs.readFileSync(file('lighter-1s', H12));

    now += 1_000;
    const bad = sink({}, dir, failing());
    bad.write('lighter-1s', H12 + 5_000, { n: 2 }, false);
    await bad.closeAll();

    expect(fs.readFileSync(file('lighter-1s', H12)).equals(before)).toBe(true);
    expect(readRows(file('lighter-1s', H12))).toEqual([{ n: 1 }]);
    expect(names().filter((n) => n.includes('.part'))).toEqual([]);
    expect(failedFiles()).toHaveLength(1);
    expect(gaps.map((g) => g.reason)).toEqual(['write-error']);
  });

  it('C: an error mid-hour does not hang closeAll, drops later rows and reports the span', async () => {
    const s = sink({ pushEveryMs: 0 }, dir, failing());
    s.write('lighter-1s', H12 + 1_000, { n: 1 }, false);
    now += 20_000;
    // The tick pushes the batch into gzip and sync-flushes it: the first file write fails now.
    s.tick(now);
    await until(() => !s.write('lighter-1s', H12 + 21_000, { n: 2 }, false));
    expect(s.dropped).toBeGreaterThanOrEqual(1);
    expect(logs).toContain('sink-error');

    now += 3_600_000;
    await s.closeAll();
    expect(names().filter((n) => n.endsWith('.jsonl.gz'))).toEqual([]);
    expect(failedFiles()).toHaveLength(1);
    // The failure came 20 s in, but the rows from the first one (1 s in) are all unpublished.
    expect(gaps).toEqual([
      expect.objectContaining({ reason: 'write-error', venue: 'lighter', coin: null, from: H12 + 1_000, stream: 'lighter-1s' }),
    ]);
    expect(gaps[0].to).toBe(H12 + 5_000 + 20_000 + 3_600_000);
  });

  it('C: also resolves when the hour rolls over by itself', async () => {
    const s = sink({ pushEveryMs: 0, lateGraceMs: 0 }, dir, failing());
    s.write('binance-1s', H12 + 1_000, { n: 1 }, false);
    s.tick(now + 1_000);
    await until(() => !s.write('binance-1s', H12 + 2_000, { n: 2 }, false));
    now = H12 + HOUR + 1;
    s.tick(now);
    await until(() => gaps.length > 0);
    expect(gaps[0]).toMatchObject({ venue: 'binance', reason: 'write-error' });
    await s.closeAll();
  });

  it('survives an open that throws', async () => {
    const s = sink({}, dir, {
      openFile: () => {
        throw new Error('EACCES');
      },
    });
    expect(s.write('lighter-1s', H12, { n: 1 }, false)).toBe(false);
    await s.closeAll();
    expect(gaps.map((g) => g.reason)).toEqual(['write-error']);
  });
});

describe('TapeSink disk floor', () => {
  const GB = 1024 ** 3;

  function floorSink(free: { bytes: number }, config: Partial<SinkConfig> = {}) {
    return sink({ minFreeBytes: 10 * GB, ...config }, dir, {
      statfs: async () => ({ bavail: free.bytes, bsize: 1 }),
    });
  }

  it('stops writing below the floor, reports it, and resumes with one gap line', async () => {
    const free = { bytes: 50 * GB };
    const s = floorSink(free);
    await s.checkDisk();
    expect(s.freeGb).toBe(50);
    expect(s.write('lighter-1s', H12, { n: 1 }, false)).toBe(true);

    free.bytes = 9 * GB;
    now += 61_000;
    await s.checkDisk();
    expect(s.diskFloorActive).toBe(true);
    expect(s.freeGb).toBe(9);
    expect(s.write('lighter-1s', H12 + 61_000, { n: 2 }, false)).toBe(false);
    expect(s.write('binance-burst', H12 + 61_000, { n: 3 }, true)).toBe(false);
    expect(s.diskDropped).toBe(2);
    expect(gaps).toEqual([]);

    // 10.2 GB is above the floor but inside the 5% resume margin.
    free.bytes = 10.2 * GB;
    now += 60_000;
    await s.checkDisk();
    expect(s.diskFloorActive).toBe(true);

    free.bytes = 20 * GB;
    now += 60_000;
    await s.checkDisk();
    expect(s.diskFloorActive).toBe(false);
    expect(gaps).toEqual([{ venue: 'tape', coin: null, reason: 'disk-floor', from: H12 + 66_000, to: H12 + 186_000 }]);
    expect(s.write('lighter-1s', H12 + 186_000, { n: 4 }, false)).toBe(true);
    await s.closeAll();
    expect(readRows(file('lighter-1s', H12))).toEqual([{ n: 1 }, { n: 4 }]);
  });

  it('checks once a minute from tick and when a new hour file opens', async () => {
    const free = { bytes: 50 * GB };
    let probes = 0;
    const s = sink({ minFreeBytes: 10 * GB }, dir, {
      statfs: async () => {
        probes++;
        return { bavail: free.bytes, bsize: 1 };
      },
    });
    await s.checkDisk();
    expect(probes).toBe(1);
    now += 30_000;
    s.tick(now);
    expect(probes).toBe(1);
    now += 31_000;
    free.bytes = 1 * GB;
    s.tick(now);
    await until(() => s.diskFloorActive);
    expect(probes).toBe(2);
    expect(s.write('lighter-1s', now, { n: 1 }, false)).toBe(false);
    await s.closeAll();
  });

  it('reports a floor that is still open at shutdown, and keeps the old state when statfs fails', async () => {
    const free = { bytes: 1 * GB };
    let fail = false;
    const s = sink({ minFreeBytes: 10 * GB }, dir, {
      statfs: async () => {
        if (fail) throw new Error('statfs failed');
        return { bavail: free.bytes, bsize: 1 };
      },
    });
    await s.checkDisk();
    expect(s.diskFloorActive).toBe(true);
    fail = true;
    now += 60_000;
    await s.checkDisk();
    expect(s.diskFloorActive).toBe(true);
    expect(logs).toContain('statfs-error');
    await s.closeAll();
    expect(gaps).toEqual([{ venue: 'tape', coin: null, reason: 'disk-floor', from: H12 + 5_000, to: H12 + 65_000 }]);
  });

  it('a floor of 0 disables the check', async () => {
    const s = sink({ minFreeBytes: 0 }, dir, {
      statfs: async () => {
        throw new Error('must not be called');
      },
    });
    await s.checkDisk();
    expect(s.write('lighter-1s', H12, { n: 1 }, false)).toBe(true);
    await s.closeAll();
  });
});

describe('TapeSink crashed leftovers', () => {
  const day = () => path.join(dir, '2026-11-11');

  /** A real gzip stream cut off in the middle, like a crash leaves. */
  function truncatedGzip(rows: object[]): Buffer {
    const full = zlib.gzipSync(rows.map((r) => `${JSON.stringify(r)}\n`).join(''), { level: 0 });
    return full.subarray(0, full.length - 12);
  }

  function leftover(name: string, content: Buffer | string): string {
    fs.mkdirSync(day(), { recursive: true });
    const file = path.join(day(), name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('writes a crashed-file gap from the first readable row to the previous heartbeat', async () => {
    leftover('lighter-1s-12.jsonl.gz.1700.1.tmp', truncatedGzip([{ t: H12 + 30 * 60_000, coin: 'BTC' }, { t: H12 + 31 * 60_000 }]));
    fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({ t: H12 + 45 * 60_000 }));
    now = H12 + 50 * 60_000;
    await sink().recoverStale();
    expect(gaps).toEqual([
      {
        venue: 'lighter',
        coin: null,
        reason: 'crashed-file',
        from: H12 + 30 * 60_000,
        to: H12 + 45 * 60_000,
        stream: 'lighter-1s',
        file: `2026-11-11/lighter-1s-12.jsonl.gz.1700.1.crashed-${now}`,
      },
    ]);
    expect(names()).toEqual([`lighter-1s-12.jsonl.gz.1700.1.crashed-${now}`]);
  });

  it('falls back to the hour start when no row is readable, and to the hour end when the heartbeat is later or missing', async () => {
    leftover('binance-burst-12.jsonl.gz.1700.2.tmp', 'not gzip at all');
    leftover('lighter-trades-12.jsonl.gz.1700.3.tmp', '');
    fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({ t: H12 + 2 * HOUR }));
    await sink().recoverStale();
    expect(gaps).toHaveLength(2);
    for (const g of gaps) expect(g).toMatchObject({ reason: 'crashed-file', from: H12, to: H12 + HOUR });
    expect(gaps.map((g) => g.stream).sort()).toEqual(['binance-burst', 'lighter-trades']);
    expect(gaps.find((g) => g.stream === 'binance-burst')?.venue).toBe('binance');

    fs.rmSync(path.join(dir, 'heartbeat.json'));
    gaps.length = 0;
    leftover('lighter-1s-12.jsonl.gz.1700.4.tmp', '');
    await sink().recoverStale();
    expect(gaps).toEqual([expect.objectContaining({ from: H12, to: H12 + HOUR })]);
  });

  it('a heartbeat before the first row never makes a negative span', async () => {
    leftover('lighter-1s-12.jsonl.gz.1700.5.tmp', truncatedGzip([{ t: H12 + 40 * 60_000 }, { t: H12 + 41 * 60_000 }]));
    fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({ t: H12 + 10 * 60_000 }));
    await sink().recoverStale();
    expect(gaps[0].from).toBe(H12 + 40 * 60_000);
    expect(gaps[0].to).toBe(H12 + 40 * 60_000);
  });

  it('a tmp file with another link is the remnant of a crash between link and unlink: unlinked, no gap, published file intact', async () => {
    const good = sink();
    good.write('lighter-1s', H12 + 1_000, { n: 1 }, false);
    await good.closeAll();
    const published = file('lighter-1s', H12);
    const before = fs.readFileSync(published);
    const remnant = `${published}.1700.1.tmp`;
    fs.linkSync(published, remnant);
    expect(fs.statSync(published).nlink).toBe(2);
    leftover('binance-1s-12.jsonl.gz.1700.2.tmp', 'real leftover');
    gaps.length = 0;

    const recovered = await sink().recoverStale();
    expect(fs.existsSync(remnant)).toBe(false);
    expect(fs.statSync(published).nlink).toBe(1);
    expect(fs.readFileSync(published).equals(before)).toBe(true);
    expect(readRows(published)).toEqual([{ n: 1 }]);
    // Only the real leftover is renamed and reported.
    expect(recovered).toHaveLength(1);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ stream: 'binance-1s', reason: 'crashed-file' });
    expect(names().filter((n) => n.includes('crashed'))).toHaveLength(1);
    expect(logs).toContain('recover-unlinked-published');
  });
});

describe('TapeSink closed hours (never reopened)', () => {
  it('a row for an hour that has begun closing is refused with one late-row gap, never reopening a stream', async () => {
    const opened: string[] = [];
    const s = sink({ lateGraceMs: 15_000 }, dir, {
      openFile: (f) => {
        opened.push(f);
        return fs.createWriteStream(f);
      },
    });
    s.write('lighter-trades', H12 + 3_000_000, { n: 1 }, false);
    now = H12 + HOUR + 15_000;
    s.tick(now);
    await until(() => fs.existsSync(file('lighter-trades', H12)));
    const published = fs.readFileSync(file('lighter-trades', H12));
    expect(opened).toHaveLength(1);

    // The wall clock steps back 14 s: the late check alone would accept this row.
    now = H12 + HOUR + 1_000;
    expect(s.write('lighter-trades', H12 + HOUR - 500, { n: 2 }, false)).toBe(false);
    expect(s.write('lighter-trades', H12 + HOUR - 400, { n: 3 }, false)).toBe(false);
    expect(s.late).toBe(2);
    expect(opened).toHaveLength(1);
    expect(gaps).toEqual([
      {
        venue: 'lighter',
        coin: null,
        reason: 'late-row',
        from: H12 + HOUR - 500,
        to: H12 + HOUR + 1_000,
        stream: 'lighter-trades',
        file: '2026-11-11/lighter-trades-12.jsonl.gz',
      },
    ]);
    await s.closeAll();
    expect(fs.readFileSync(file('lighter-trades', H12)).equals(published)).toBe(true);
    expect(readRows(file('lighter-trades', H12))).toEqual([{ n: 1 }]);
    expect(names().some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('closes in-flight work and also refuses rows for a stream closed by closeAll', async () => {
    const s = sink();
    s.write('binance-1s', H12 + 1_000, { n: 1 }, false);
    await s.closeAll();
    expect(s.write('binance-1s', H12 + 2_000, { n: 2 }, false)).toBe(false);
    expect(gaps.map((g) => g.reason)).toEqual(['late-row']);
    expect(readRows(file('binance-1s', H12))).toEqual([{ n: 1 }]);
  });

  it('gives every open its own tmp path (boot time and a sequence number)', async () => {
    const opened: string[] = [];
    const s = sink({}, dir, {
      openFile: (f) => {
        opened.push(f);
        return fs.createWriteStream(f);
      },
    });
    for (const name of ['lighter-1s', 'binance-1s', 'lighter-burst', 'binance-burst', 'lighter-trades'] as const) {
      s.write(name, H12, { n: 1 }, false);
    }
    s.write('lighter-1s', H12 + HOUR, { n: 2 }, false);
    expect(new Set(opened).size).toBe(6);
    const seqs = opened.map((p) => Number(/\.(\d+)\.tmp$/.exec(p)?.[1]));
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    // A second sink started in the same millisecond still cannot reuse a path of a leftover: the leftover is renamed away first.
    await s.closeAll();
  });

  it('forgets closed hours after a while', async () => {
    const s = sink({ lateGraceMs: 0 });
    s.write('lighter-1s', H12, { n: 1 }, false);
    now = H12 + HOUR;
    s.tick(now);
    now = H12 + 3 * HOUR;
    s.tick(now);
    await s.closeAll();
    // Still refused (late), but by the late check, with no growth of the closed set.
    expect(s.write('lighter-1s', H12 + 1, { n: 2 }, false)).toBe(false);
    expect(gaps).toEqual([]);
  });
});
