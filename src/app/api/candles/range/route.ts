import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { getCandleRange } from '@/lib/candle-ingestion';
import { VALID_INTERVALS } from '@/lib/models/candle';

const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(VALID_INTERVALS),
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

  const { symbol, interval } = parsed.data;

  try {
    const range = await getCandleRange(symbol, interval);
    return NextResponse.json(range);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to get candle range';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
