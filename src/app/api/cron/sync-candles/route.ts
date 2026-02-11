import { NextRequest, NextResponse } from 'next/server';

import { syncCandles } from '@/lib/candle-ingestion';
import { Strategy } from '@/lib/models/strategy';
import { Watchlist } from '@/lib/models/watchlist';
import { VALID_INTERVALS } from '@/lib/models/candle';
import { connectDB } from '@/lib/mongodb';

const MAX_PAIRS_PER_RUN = 20;

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

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
    for (const interval of VALID_INTERVALS) {
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
  });
}
