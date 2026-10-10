// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { deflateRawSync, crc32 } from 'node:zlib';
import { setTimeout as realSleep } from 'node:timers/promises';

import { ARCHIVE_CADENCE, archiveFileName, archiveUrl, streamArchiveCsvLines } from './binance-archive';

type Variant = 'sizes' | 'descriptor-signed' | 'descriptor-unsigned' | 'descriptor-zip64';

function buildStreamZip(contents: string, variant: Variant, opts: { badCrc?: boolean } = {}): Buffer {
  const raw = Buffer.from(contents, 'utf8');
  const body = deflateRawSync(raw);
  const name = Buffer.from('BTCUSDT-aggTrades-2026-10-08.csv');
  const crc = (crc32(raw) ^ (opts.badCrc ? 1 : 0)) >>> 0;
  const descriptor = variant !== 'sizes';
  const extra = variant === 'descriptor-zip64' ? Buffer.from([1, 0, 16, 0, ...new Array(16).fill(0)]) : Buffer.alloc(0);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(descriptor ? 0x0008 : 0, 6);
  local.writeUInt16LE(8, 8);
  if (!descriptor) {
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
  }
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);

  let desc = Buffer.alloc(0);
  if (variant === 'descriptor-signed') {
    desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(body.length, 8);
    desc.writeUInt32LE(raw.length, 12);
  } else if (variant === 'descriptor-unsigned') {
    desc = Buffer.alloc(12);
    desc.writeUInt32LE(crc, 0);
    desc.writeUInt32LE(body.length, 4);
    desc.writeUInt32LE(raw.length, 8);
  } else if (variant === 'descriptor-zip64') {
    desc = Buffer.alloc(24);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeBigUInt64LE(BigInt(body.length), 8);
    desc.writeBigUInt64LE(BigInt(raw.length), 16);
  }
  // A stand-in central directory, which the streaming reader must never need.
  const central = Buffer.alloc(80, 0x50);
  return Buffer.concat([local, name, extra, body, desc, central]);
}

function chunked(buf: Buffer, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= buf.length) return controller.close();
      controller.enqueue(new Uint8Array(buf.subarray(at, at + size)));
      at += size;
    },
  });
}

function mockFetchOnce(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

const spec = { dataset: 'aggTrades', symbol: 'BTCUSDT', date: '2026-10-08', cadence: 'daily' } as const;
const CSV = 'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\r\n' +
  Array.from({ length: 300 }, (_, i) => `${i},100.5,0.25,${i},${i},${1_700_000_000_000 + i},${i % 2 === 0}\r\n`).join('');
const EXPECTED = CSV.split('\r\n').filter(Boolean);

async function collect(opts = {}): Promise<{ lines: string[]; result: Awaited<ReturnType<typeof streamArchiveCsvLines>> }> {
  const lines: string[] = [];
  const result = await streamArchiveCsvLines(spec, (l) => void lines.push(l), { retryBaseMs: 0, ...opts });
  return { lines, result };
}

afterEach(() => vi.unstubAllGlobals());

describe('aggTrades archive spec', () => {
  it('is monthly by default and builds the documented URL', () => {
    expect(ARCHIVE_CADENCE.aggTrades).toBe('monthly');
    const monthly = { dataset: 'aggTrades', symbol: 'BTCUSDT', date: '2024-03' } as const;
    expect(archiveFileName(monthly)).toBe('BTCUSDT-aggTrades-2024-03.zip');
    expect(archiveUrl(monthly)).toBe(
      'https://data.binance.vision/data/futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-03.zip'
    );
    expect(archiveUrl(spec)).toContain('/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-10-08.zip');
  });

  it('rejects an interval', () => {
    expect(() => archiveUrl({ ...spec, interval: '1h' })).toThrow(/no interval/);
  });
});

describe('streamArchiveCsvLines', () => {
  const variants: Variant[] = ['sizes', 'descriptor-signed', 'descriptor-unsigned', 'descriptor-zip64'];
  for (const variant of variants) {
    for (const size of [1, 7, 31, 100, 100_000]) {
      it(`reads ${variant} with ${size}-byte chunks`, async () => {
        mockFetchOnce(new Response(chunked(buildStreamZip(CSV, variant), size), { status: 200 }));
        const { lines, result } = await collect();
        expect(lines).toEqual(EXPECTED);
        expect(result).toEqual({ status: 'ok', lines: EXPECTED.length, uncompressedBytes: Buffer.byteLength(CSV) });
      });
    }
  }

  it('handles a final line without a trailing newline', async () => {
    mockFetchOnce(new Response(chunked(buildStreamZip('a,1\nb,2', 'sizes'), 3), { status: 200 }));
    expect((await collect()).lines).toEqual(['a,1', 'b,2']);
  });

  it('awaits an async consumer in order', async () => {
    mockFetchOnce(new Response(chunked(buildStreamZip(CSV, 'descriptor-signed'), 50), { status: 200 }));
    const seen: string[] = [];
    await streamArchiveCsvLines(
      spec,
      async (l) => {
        await new Promise((r) => setTimeout(r, 0));
        seen.push(l);
      },
      { retryBaseMs: 0 }
    );
    expect(seen).toEqual(EXPECTED);
  });

  for (const variant of ['sizes', 'descriptor-signed', 'descriptor-unsigned'] as Variant[]) {
    it(`throws on a crc mismatch (${variant})`, async () => {
      mockFetchOnce(new Response(chunked(buildStreamZip(CSV, variant, { badCrc: true }), 13), { status: 200 }));
      await expect(collect()).rejects.toThrow(/crc32/);
    });
  }

  it('does not retry an integrity failure', async () => {
    const fn = mockFetchOnce(new Response(chunked(buildStreamZip(CSV, 'sizes', { badCrc: true }), 64), { status: 200 }));
    await expect(collect()).rejects.toThrow(/crc32/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws on a truncated body', async () => {
    const zip = buildStreamZip(CSV, 'descriptor-signed');
    mockFetchOnce(new Response(chunked(zip.subarray(0, 60), 10), { status: 200 }));
    await expect(collect()).rejects.toThrow();
  });

  it('resolves a 404 to missing', async () => {
    mockFetchOnce(new Response('nope', { status: 404 }));
    const { result } = await collect();
    expect(result).toEqual({ status: 'missing' });
  });

  it('retries a 503 then succeeds', async () => {
    const fn = mockFetchOnce(
      new Response('busy', { status: 503 }),
      new Error('socket hang up'),
      new Response(chunked(buildStreamZip(CSV, 'sizes'), 40), { status: 200 })
    );
    const { lines } = await collect();
    expect(lines).toEqual(EXPECTED);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after bounded attempts', async () => {
    const fn = mockFetchOnce(...Array.from({ length: 4 }, () => new Response('busy', { status: 503 })));
    await expect(collect()).rejects.toThrow(/HTTP 503/);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not retry a 403', async () => {
    const fn = mockFetchOnce(new Response('no', { status: 403 }));
    await expect(collect()).rejects.toThrow(/HTTP 403/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('restarts after a mid-stream failure only when asked to', async () => {
    const zip = buildStreamZip(CSV, 'sizes');
    const failing = (): ReadableStream<Uint8Array> => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array(zip.subarray(0, zip.length - 40)));
          } else controller.error(new Error('reset'));
        },
      });
    };
    mockFetchOnce(new Response(failing(), { status: 200 }));
    await expect(collect()).rejects.toThrow();

    mockFetchOnce(new Response(failing(), { status: 200 }), new Response(chunked(zip, 90), { status: 200 }));
    const restarts = vi.fn();
    const lines: string[] = [];
    await streamArchiveCsvLines(spec, (l) => void lines.push(l), { retryBaseMs: 0, onRestart: () => { restarts(); lines.length = 0; } });
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(EXPECTED);
  });
});

describe('streamArchiveCsvLines idle timeout', () => {
  /** A body whose reads fail once `signal` aborts, like a real fetch body. Pulls only when read. */
  function abortableBody(
    chunks: Buffer[],
    signal: AbortSignal,
    stallAfter: boolean,
    pulled?: { count: number }
  ): ReadableStream<Uint8Array> {
    let at = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (signal.aborted) throw new Error('aborted');
          if (at < chunks.length) {
            if (pulled) pulled.count = at + 1;
            controller.enqueue(new Uint8Array(chunks[at++]));
            return;
          }
          if (!stallAfter) return controller.close();
          return new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      },
      { highWaterMark: 0 }
    );
  }

  /** Advances the fake clock in steps, yielding to real I/O (zlib) between them, until `settled` resolves. */
  async function pump<T>(settled: Promise<T>, totalMs: number): Promise<T> {
    let done = false;
    void settled.then(() => {
      done = true;
    });
    for (let elapsed = 0; !done && elapsed < totalMs; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return settled;
  }

  afterEach(() => vi.useRealTimers());

  it('does not abort a healthy stream while the consumer is slow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const big =
      'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\r\n' +
      Array.from(
        { length: 100_000 },
        (_, i) => `${i},${100 + (i % 97) * 0.37},0.25,${i},${i},${1_700_000_000_000 + i * 7},${i % 2 === 0}\r\n`
      ).join('');
    const zip = buildStreamZip(big, 'sizes');
    const chunks: Buffer[] = [];
    for (let i = 0; i < zip.length; i += 256) chunks.push(zip.subarray(i, i + 256));
    const pulled = { count: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: { signal: AbortSignal }) =>
          new Response(abortableBody(chunks, init.signal, false, pulled))
      )
    );

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const settled = streamArchiveCsvLines(
      spec,
      async () => {
        // The consumer blocks, once, until the test lets it go.
        if (count++ === 5) await gate;
      },
      { retryBaseMs: 0, idleTimeoutMs: 1_000 }
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );

    // Wait (in real time) until the network reads stop because the consumer is blocked.
    let last = -1;
    let steady = 0;
    while (steady < 5) {
      await realSleep(10);
      steady = pulled.count === last ? steady + 1 : 0;
      last = pulled.count;
    }
    expect(pulled.count).toBeLessThan(chunks.length);

    // Far longer than the idle timeout, with no network read pending.
    await vi.advanceTimersByTimeAsync(10_000);
    release();
    const outcome = await settled;
    expect('error' in outcome ? outcome.error : null).toBeNull();
    expect(count).toBe(100_001);
  });

  it('still aborts a stalled network read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const zip = buildStreamZip(CSV, 'sizes');
    const fetchMock = vi.fn(
      async (_url: string, init: { signal: AbortSignal }) =>
        new Response(abortableBody([zip.subarray(0, 10)], init.signal, true))
    );
    vi.stubGlobal('fetch', fetchMock);

    const settled = streamArchiveCsvLines(spec, () => undefined, { retryBaseMs: 0, idleTimeoutMs: 1_000 }).then(
      () => 'resolved',
      (error: unknown) => (error as Error).message
    );
    expect(await pump(settled, 10_000)).toBe('aborted');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
