import { NextRequest, NextResponse } from 'next/server';

import { syncCandles } from '@/lib/candle-ingestion';
import { Strategy } from '@/lib/models/strategy';
import { Watchlist } from '@/lib/models/watchlist';
import { VALID_INTERVALS, type CandleInterval } from '@/lib/models/candle';
import { connectDB } from '@/lib/mongodb';

const MAX_PAIRS_PER_RUN = 20;

/** Standard intervals synced by default (excludes HF intervals 1m/5m) */
const STANDARD_INTERVALS: CandleInterval[] = ['15m', '1h', '4h', '1d'];

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

/**
 * Parse the ?intervals= query param into validated CandleInterval[].
 * Supports comma-separated values: ?intervals=1m,5m
 * Falls back to STANDARD_INTERVALS if not provided.
 */
function parseIntervals(req: NextRequest): CandleInterval[] {
  const param = req.nextUrl.searchParams.get('intervals');
  if (!param) return STANDARD_INTERVALS;

  const requested = param.split(',').map((s) => s.trim());
  const valid = requested.filter((i): i is CandleInterval =>
    (VALID_INTERVALS as readonly string[]).includes(i)
  );

  return valid.length > 0 ? valid : STANDARD_INTERVALS;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const intervals = parseIntervals(req);

  // Collect unique symbols from strategies and watchlists
  const symbolSet = new Set<string>();

  const strategies = await Strategy.find({ active: true }).select('symbols');
  for (const s of strategies) {
    for (const sym of s.symbols) {
      symbolSet.add(sym);
    }
  }

  const watchlists = await Watchlist.find().select('symbols');
  for (const w of watchlists) {
    for (const sym of w.symbols) {
      symbolSet.add(sym);
    }
  }

  // Build (symbol, interval) pairs
  const pairs: Array<{ symbol: string; interval: string }> = [];
  for (const symbol of symbolSet) {
    for (const interval of intervals) {
      pairs.push({ symbol, interval });
    }
  }

  // Limit to MAX_PAIRS_PER_RUN
  const toSync = pairs.slice(0, MAX_PAIRS_PER_RUN);

  let synced = 0;
  let errors = 0;
  let totalInserted = 0;

  for (const { symbol, interval } of toSync) {
    try {
      const result = await syncCandles(symbol, interval);
      totalInserted += result.inserted;
      synced++;
    } catch {
      errors++;
    }
  }

  return NextResponse.json({
    synced,
    errors,
    totalInserted,
    pairs: toSync.length,
    intervals,
  });
}
