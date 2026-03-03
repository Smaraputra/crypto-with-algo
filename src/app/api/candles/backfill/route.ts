import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { backfillCandles, getCandleRange } from '@/lib/candle-ingestion';
import { VALID_INTERVALS } from '@/lib/models/candle';

const bodySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(VALID_INTERVALS),
  months: z.number().min(1).max(60).default(24),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { symbol, interval, months } = parsed.data;

  try {
    const result = await backfillCandles(symbol, interval, months);
    const range = await getCandleRange(symbol, interval);

    return NextResponse.json({
      inserted: result.inserted,
      total: range.count,
      oldest: range.oldest,
      newest: range.newest,
    });
  } catch (err) {
    console.error('Backfill error:', err);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
