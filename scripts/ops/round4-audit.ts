/**
 * Read-only Round 4 audit. MONGODB_URI must be supplied by the caller.
 * Run replay|candles --out PATH using the project's existing tsx runner.
 * Candles accepts --from YYYY-MM-DD --to YYYY-MM-DD --cache /explicit/path.
 * JSON summary and streaming JSONL details are the only default writes.
 */
import { fetchArchiveFile, parseKlineCsv } from '@/lib/external/binance-archive';
import type { OHLCV } from '@/types/market';
import { MongoClient, type Db, type Filter } from 'mongodb';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  auditCandles,
  auditReplay,
  AuditValidationError,
  externalFailureTag,
  parseAuditArgs,
  type CandleBar,
  type ReplayAdapters,
  type ReplayRow,
} from '../research/round4-audit-core';

export function validateOutputPaths(output: string, cache?: string) {
  const out = resolve(output);
  const rows = `${out}.rows.jsonl`;
  if (cache && !isAbsolute(cache))
    throw new AuditValidationError('--cache requires an explicit absolute path');
  if (
    cache &&
    [out, rows].some((p) => {
      const rel = relative(resolve(cache), p);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    })
  )
    throw new AuditValidationError('cache and audit output paths overlap');
  return { out, rows };
}
export function parseAuditArchive(csv: string): { bars: CandleBar[]; invalidLines: number } {
  const bars: CandleBar[] = [];
  let invalidLines = 0;
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(open_time|open time|opentime),/i.test(line)) continue;
    const fields = line.split(',');
    // The shared parser defaults malformed volume to zero, so validate first.
    const numeric = [0, 1, 2, 3, 4, 5, 7, 8, 9];
    if (
      fields.length < 12 ||
      !numeric.every((i) => fields[i]?.trim() !== '' && Number.isFinite(Number(fields[i])))
    ) {
      invalidLines++;
      continue;
    }
    const parsed = parseKlineCsv(line);
    if (parsed.length !== 1) {
      invalidLines++;
      continue;
    }
    const b = parsed[0];
    bars.push({ ...b, takerBuyVolume: b.takerBuyVolume ?? undefined });
  }
  return { bars, invalidLines };
}
function historicalBars(
  db: Db,
  venue: 'spot' | 'perp',
  symbol: string,
  interval: string,
  from: number,
  to: number
): Promise<CandleBar[]> {
  return db
    .collection<CandleBar>(venue === 'spot' ? 'candles' : 'perpcandles')
    .find(
      {
        symbol,
        interval,
        ...(venue === 'perp' ? { series: 'klines' } : {}),
        timestamp: { $gte: from, $lt: to },
      },
      {
        projection: {
          _id: 0,
          timestamp: 1,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          takerBuyVolume: 1,
          quoteVolume: 1,
          trades: 1,
        },
      }
    )
    .sort({ timestamp: 1, _id: 1 })
    .toArray();
}
export function mongoReplayAdapters(db: Db, watermark: Filter<ReplayRow>): ReplayAdapters {
  return {
    rv: async (barTime) => {
      const rows = await db
        .collection('rvsignals')
        .find({ version: 'rv-v1', barTime })
        .limit(2)
        .toArray();
      if (rows.length > 1) throw new AuditValidationError('pinned rvsignals record duplicated');
      return rows.length ? { ranked: rows[0].ranked } : null;
    },
    bars: async (...args) => historicalBars(db, ...args) as Promise<OHLCV[]>,
    ratios: async (symbol, from, to) =>
      db
        .collection<{ timestamp: number; longShortRatio: number }>('labratiopoints')
        .find(
          { symbol, period: '4h', timestamp: { $gte: from, $lte: to } },
          { projection: { _id: 0, timestamp: 1, longShortRatio: 1 } }
        )
        .sort({ timestamp: 1, _id: 1 })
        .toArray(),
    prior: async (row, from, to) =>
      db
        .collection<ReplayRow>('labsignals')
        .find({
          ...watermark,
          version: row.version,
          hypothesis: row.hypothesis,
          barClose: { $gt: from, $lt: to },
        })
        .sort({ barClose: 1, writtenAt: 1, _id: 1 })
        .toArray(),
  };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseAuditArgs(args);
  const paths = validateOutputPaths(options.out, options.cache);
  if (!process.env.MONGODB_URI)
    throw new AuditValidationError('MONGODB_URI environment variable is required');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  let rowsFile: Awaited<ReturnType<typeof open>> | undefined;
  const startedAt = new Date();
  try {
    const db = client.db();
    await mkdir(dirname(paths.out), { recursive: true });
    const detailFile = await open(paths.rows, 'wx');
    rowsFile = detailFile;
    const sink = async (r: unknown) => {
      await detailFile.write(`${JSON.stringify(r)}\n`);
    };
    let result: unknown;
    let snapshot: unknown;
    if (options.command === 'replay') {
      const collection = db.collection<ReplayRow>('labsignals');
      const newest = await collection.find({}).sort({ _id: -1 }).limit(1).next();
      const watermark: Filter<ReplayRow> = newest
        ? { _id: { $lte: newest._id } }
        : { _id: { $exists: false } };
      const expectedRows = await collection.countDocuments(watermark);
      const maximumBar = await collection
        .find(watermark)
        .sort({ barClose: -1, _id: -1 })
        .limit(1)
        .next();
      const maximumWritten = await collection
        .find(watermark)
        .sort({ writtenAt: -1, _id: -1 })
        .limit(1)
        .next();
      snapshot = {
        startedAt: startedAt.toISOString(),
        maximumId: newest ? String(newest._id) : null,
        maximumBarClose: maximumBar?.barClose ?? null,
        maximumWrittenAt: maximumWritten?.writtenAt ?? null,
        expectedRows,
        consistency:
          'immutable collection with fixed maximum _id; counts checked before and after; not a transactional snapshot',
        comparisonScope:
          'frozen scoring functions; exact numeric score equality; F1 book replay reported separately',
      };
      const cursor = collection
        .find(watermark)
        .sort({ barClose: 1, writtenAt: 1, _id: 1 })
        .batchSize(100);
      try {
        result = await auditReplay(cursor, mongoReplayAdapters(db, watermark), sink);
      } finally {
        await cursor.close();
      }
      if (
        (result as { total: number }).total !== expectedRows ||
        (await collection.countDocuments(watermark)) !== expectedRows
      )
        throw new AuditValidationError(
          'labsignals changed during audit; JSONL is partial evidence; rerun with a new --out path'
        );
    } else {
      snapshot = {
        startedAt: startedAt.toISOString(),
        from: options.from,
        to: options.to,
        intervalConvention: '[from,to)',
        source: 'spot candles vs spotKlines; perpetual klines vs klines',
        invalidArchiveLineScope:
          'whole archive month when malformed timestamps cannot be assigned to a narrowed date range',
        sourceGaps:
          'unavailable months and missingArchive/missingBoth are archive source gaps, not evidence that stored candles are incorrect',
        tolerance: { relative: 1e-10, absolute: 1e-12 },
      };
      result = await auditCandles(
        options,
        {
          stored: (...args) => historicalBars(db, ...args),
          archive: async (spec) => {
            const csv = await fetchArchiveFile(
              spec,
              options.cache ? { cacheDir: options.cache } : {}
            );
            return csv === null ? null : parseAuditArchive(csv);
          },
        },
        sink
      );
    }
    await rowsFile.sync();
    const summary = {
      command: options.command,
      snapshot,
      finishedAt: new Date().toISOString(),
      details: paths.rows,
      result,
    };
    await writeFile(paths.out, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    console.log(
      JSON.stringify({
        startedAt: startedAt.toISOString(),
        finishedAt: summary.finishedAt,
        counts:
          result && typeof result === 'object'
            ? Object.fromEntries(Object.entries(result).filter(([, v]) => typeof v === 'number'))
            : {},
      })
    );
  } finally {
    await rowsFile?.close();
    await client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      `Round 4 audit failed: ${error instanceof AuditValidationError ? error.message : externalFailureTag(error)}`
    );
    process.exitCode = 1;
  });
}
