import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { fetchKlines } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const VALID_INTERVALS = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '12h',
  '1d', '1w', '1M',
] as const;

const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(VALID_INTERVALS),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  startTime: z.coerce.number().int().positive().optional(),
  endTime: z.coerce.number().int().positive().optional(),
});

const TTL_MAP: Record<string, number> = {
  '1m': 10,
  '3m': 15,
  '5m': 30,
  '15m': 60,
  '30m': 60,
  '1h': 120,
  '2h': 180,
  '4h': 300,
  '6h': 300,
  '12h': 600,
  '1d': 600,
  '1w': 1800,
  '1M': 3600,
};

const limiter = createRateLimiter(20, '60 s');

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimit(req, limiter);
  if (limited) return limited;

  const { searchParams } = req.nextUrl;
  const parsed = querySchema.safeParse({
    symbol: searchParams.get('symbol'),
    interval: searchParams.get('interval'),
    limit: searchParams.get('limit') ?? undefined,
    startTime: searchParams.get('startTime') ?? undefined,
    endTime: searchParams.get('endTime') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { symbol, interval, limit, startTime, endTime } = parsed.data;
  const ttl = TTL_MAP[interval] ?? 60;

  const cacheKey = startTime || endTime
    ? `klines:${symbol}:${interval}:${limit}:${startTime ?? ''}:${endTime ?? ''}`
    : `klines:${symbol}:${interval}:${limit}`;

  try {
    const data = await cachedFetch(
      cacheKey,
      () => fetchKlines(symbol, interval, limit, startTime, endTime),
      ttl
    );

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`,
      },
    });
  } catch (error) {
    console.error('Failed to fetch klines:', error);
    return NextResponse.json({ error: 'Failed to fetch price history' }, { status: 500 });
  }
}
