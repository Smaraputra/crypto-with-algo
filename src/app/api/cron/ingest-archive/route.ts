import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { connectDB } from '@/lib/mongodb';
import {
  fetchArchiveFile,
  parseBookDepthCsv,
  parseMetricsCsv,
} from '@/lib/external/binance-archive';
import {
  aggregateBookDepth,
  depthUpserts,
  enumerateDays,
  metricsUpserts,
} from '@/lib/archive-ingestion';
import { FuturesMetric } from '@/lib/models/futures-metric';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

/**
 * Keeps FuturesMetric current from the Binance public data archive.
 *
 * The archive publishes a day's file after that day ends, so this can only
 * ever be a day or two behind and is a history keeper, not a live feed.
 * Anything that graduates to live trading reads the REST endpoints in
 * `src/lib/binance-futures.ts` instead, which serve the last 30 days and are
 * enough to stay current once this has seeded the history.
 *
 * Bulk history is not this route's job: use
 * `npx tsx scripts/ops/ingest-archive.ts` from the seeder image for that.
 * Here the window is small and bounded so a cron run stays short.
 *
 * Query params:
 *   days     how many days back to (re)ingest, 1 to 7, default 3
 *   symbols  comma list, default SIGNAL_SYMBOLS
 *   depth    'false' to skip the bookDepth pass
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 3;
const MAX_DAYS = 7;

function parseDays(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get('days');
  if (!raw) return DEFAULT_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) return DEFAULT_DAYS;
  return Math.min(days, MAX_DAYS);
}

function parseSymbols(req: NextRequest): string[] {
  const raw = req.nextUrl.searchParams.get('symbols');
  if (!raw) return [...SIGNAL_SYMBOLS];
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return symbols.length > 0 ? symbols : [...SIGNAL_SYMBOLS];
}

async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const days = parseDays(req);
  const symbols = parseSymbols(req);
  const withDepth = req.nextUrl.searchParams.get('depth') !== 'false';

  // Ends yesterday: today's file does not exist yet, so asking for it is a
  // guaranteed 404. The window overlaps previous runs on purpose, since every
  // write is an idempotent upsert and a day the archive published late is
  // picked up by the next run rather than lost.
  const endMs = Math.floor((Date.now() - DAY_MS) / DAY_MS) * DAY_MS;
  const startMs = endMs - (days - 1) * DAY_MS;
  const dates = enumerateDays(startMs, endMs);

  let written = 0;
  let missing = 0;
  let errors = 0;

  for (const symbol of symbols) {
    for (const date of dates) {
      try {
        const metricsCsv = await fetchArchiveFile({ dataset: 'metrics', symbol, date });
        if (metricsCsv === null) {
          missing++;
        } else {
          const ops = metricsUpserts(symbol, parseMetricsCsv(metricsCsv));
          if (ops.length > 0) {
            const result = await FuturesMetric.bulkWrite(
              ops.map((op) => ({
                updateOne: { filter: op.filter, update: { $set: op.set }, upsert: true },
              })),
              { ordered: false }
            );
            written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
          }
        }

        if (!withDepth) continue;

        const depthCsv = await fetchArchiveFile({ dataset: 'bookDepth', symbol, date });
        if (depthCsv === null) {
          missing++;
          continue;
        }
        const depthOps = depthUpserts(symbol, aggregateBookDepth(parseBookDepthCsv(depthCsv)));
        if (depthOps.length > 0) {
          const result = await FuturesMetric.bulkWrite(
            depthOps.map((op) => ({
              updateOne: { filter: op.filter, update: { $set: op.set }, upsert: true },
            })),
            { ordered: false }
          );
          written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
        }
      } catch {
        // One bad symbol-day must not abandon the rest of the window.
        errors++;
      }
    }
  }

  return NextResponse.json({
    symbols: symbols.length,
    days: dates.length,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    written,
    missing,
    errors,
  });
}

// The handler body is unchanged; the wrapper only records that the run
// happened and what it returned. A 401 writes nothing.
export const GET = withJobRun('ingest-archive', handler);
