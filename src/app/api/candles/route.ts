import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { getCandles, backfillCandles } from '@/lib/candle-ingestion';
import { VALID_INTERVALS } from '@/lib/models/candle';

const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(VALID_INTERVALS),
  startTime: z.coerce.number().optional(),
  endTime: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(50000).default(500),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { symbol, interval, startTime, endTime, limit } = parsed.data;

  try {
    // Check if we have data in the requested range
    let candles = await getCandles(symbol, interval, startTime, endTime, limit);

    // If insufficient data and a startTime was requested, trigger backfill
    if (candles.length < 10 && startTime) {
      const monthsNeeded = Math.ceil(
        (Date.now() - startTime) / (30 * 24 * 60 * 60 * 1000)
      );
      await backfillCandles(symbol, interval, Math.min(monthsNeeded, 60));
      candles = await getCandles(symbol, interval, startTime, endTime, limit);
    }

    return NextResponse.json({ candles, count: candles.length });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch candles';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
