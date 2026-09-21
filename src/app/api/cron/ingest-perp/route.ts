import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { connectDB } from '@/lib/mongodb';
import { fetchArchiveFile, parseKlineCsv } from '@/lib/external/binance-archive';
import { enumerateDays, perpCandleUpserts, perpPairsForSeries } from '@/lib/archive-ingestion';
import { bulkUpsertPerpCandles } from '@/lib/perp-candles';
import { PERP_SERIES, type PerpSeries } from '@/lib/models/perp-candle';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

/**
 * Keeps the perpetual bar series current from the Binance public data archive.
 *
 * WHY THIS IS ITS OWN ROUTE and not a third pass in `ingest-archive`:
 * `perpcandles` has no consumer in the live app (the research export is the
 * only reader), while `FuturesMetric` feeds `HistoricalSnapshot` and therefore
 * live scoring. Putting a research-only pass with ten times the fetch volume
 * into the route whose completion the live path depends on would put a
 * research job's failure mode on a live job, for no gain. The two also fail
 * for different reasons worth alarming on separately.
 *
 * THE CADENCE, which is the whole trick here. The kline datasets are published
 * BOTH monthly and daily, and `ARCHIVE_CADENCE` records the monthly default
 * because that is what bulk history wants. But a month's file does not exist
 * until that month ends, so a monthly reader is up to a month behind. The daily
 * file for a day appears the next day, so this route asks for the daily cadence
 * explicitly (`cadence: 'daily'`) and stays one day behind, exactly like the
 * metrics pass. Nothing else about the file path changes: the name and the
 * cache key already carry the date.
 *
 * History is not this route's job: `scripts/ops/ingest-archive.ts` from the
 * seeder image does the bulk load. The window here is bounded on purpose.
 *
 * Query params:
 *   days       how many days back to (re)ingest, 1 to 7, default 3
 *   to         last day to cover, 'YYYY-MM-DD', default yesterday. Present so a
 *              window OLDER than the day cap can be reached, which the day cap
 *              alone could never do; that is how a gap gets closed by hand.
 *   symbols    comma list, default SIGNAL_SYMBOLS
 *   series     comma list from PERP_SERIES, default 'klines,premiumIndex'
 *   intervals  comma list, default '5m,15m,1h,4h,1d'
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 3;
const MAX_DAYS = 7;

/** The intervals production holds for both series. */
const DEFAULT_INTERVALS = ['5m', '15m', '1h', '4h', '1d'];

/**
 * `markPrice` is deliberately NOT a default: it holds no documents, and the
 * mark price already reaches research through `HistoricalSnapshot.data.
 * fundingRate.markPrice`, written from REST by the live snapshot path. It stays
 * available here for parity with the CLI, which can still load it.
 */
const DEFAULT_SERIES: PerpSeries[] = ['klines', 'premiumIndex'];

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/** The archive's own history starts here; an earlier `to` is a typo, not intent. */
const EARLIEST_DAY_MS = Date.UTC(2021, 0, 1);

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

function parseList(req: NextRequest, param: string, fallback: readonly string[]): string[] {
  const raw = req.nextUrl.searchParams.get(param);
  if (!raw) return [...fallback];
  const values = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return values.length > 0 ? values : [...fallback];
}

/** Yesterday, floored to the UTC day: today's file does not exist yet. */
function yesterdayMs(now: number): number {
  return Math.floor((now - DAY_MS) / DAY_MS) * DAY_MS;
}

/**
 * The last day to cover. Returns an error string rather than throwing so the
 * handler can answer 400 and say which param was wrong.
 */
function parseTo(req: NextRequest, now: number): { toMs: number } | { error: string } {
  const raw = req.nextUrl.searchParams.get('to');
  const latest = yesterdayMs(now);
  if (!raw) return { toMs: latest };
  if (!DATE_SHAPE.test(raw)) {
    return { error: `Invalid --to date "${raw}", expected YYYY-MM-DD` };
  }
  const toMs = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(toMs)) return { error: `Invalid --to date "${raw}"` };
  if (toMs > latest) {
    return {
      error:
        `--to ${raw} is today or later; the archive publishes a day after it ends, ` +
        'so the newest coverable day is yesterday',
    };
  }
  if (toMs < EARLIEST_DAY_MS) {
    return { error: `--to ${raw} is before the archive's coverage, which starts 2021-01-01` };
  }
  return { toMs };
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = Date.now();
  const days = parseDays(req);
  const symbols = parseSymbols(req);

  const intervals = parseList(req, 'intervals', DEFAULT_INTERVALS);
  for (const interval of intervals) {
    if (!DEFAULT_INTERVALS.includes(interval)) {
      return NextResponse.json(
        { error: `Unknown interval "${interval}", expected one of: ${DEFAULT_INTERVALS.join(', ')}` },
        { status: 400 }
      );
    }
  }

  const requestedSeries = parseList(req, 'series', DEFAULT_SERIES);
  for (const series of requestedSeries) {
    if (!PERP_SERIES.includes(series as PerpSeries)) {
      return NextResponse.json(
        { error: `Unknown series "${series}", expected one of: ${PERP_SERIES.join(', ')}` },
        { status: 400 }
      );
    }
  }
  const pairs = perpPairsForSeries(requestedSeries as PerpSeries[]);

  const to = parseTo(req, now);
  if ('error' in to) {
    return NextResponse.json({ error: to.error }, { status: 400 });
  }

  await connectDB();

  const startMs = to.toMs - (days - 1) * DAY_MS;
  const dates = enumerateDays(startMs, to.toMs);

  let fetched = 0;
  let written = 0;
  let missing = 0;
  let errors = 0;

  // The try/catch sits at the INNERMOST level, one archive file, unlike the
  // metrics route where it wraps a symbol-day. There are ten files per
  // symbol-day here (five intervals x two series), so a symbol-day-level catch
  // would throw away nine good files to report one bad one.
  for (const symbol of symbols) {
    for (const date of dates) {
      for (const interval of intervals) {
        for (const pair of pairs) {
          try {
            const csv = await fetchArchiveFile({
              dataset: pair.dataset,
              symbol,
              interval,
              date,
              cadence: 'daily',
            });
            fetched++;
            if (csv === null) {
              missing++;
              continue;
            }
            const parsed = parseKlineCsv(csv);
            const ops = perpCandleUpserts(symbol, interval, pair.series, parsed);
            if (ops.length > 0) {
              written += await bulkUpsertPerpCandles(ops);
            }
          } catch {
            // One bad file must not abandon the rest of the window.
            errors++;
          }
        }
      }
    }
  }

  return NextResponse.json({
    symbols: symbols.length,
    series: pairs.map((pair) => pair.series),
    intervals,
    days: dates.length,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    // `fetched` is reported alongside `written` because `written` counts
    // upserted+modified, so a re-run over stored bars reports 0 while nothing
    // is wrong. Coverage is read from `missing`, not from `written`.
    fetched,
    written,
    missing,
    errors,
  });
}
