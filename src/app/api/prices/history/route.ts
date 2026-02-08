import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { fetchKlines } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';

const VALID_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(VALID_INTERVALS),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const TTL_MAP: Record<string, number> = {
  '1m': 10,
  '5m': 30,
  '15m': 60,
  '1h': 120,
  '4h': 300,
  '1d': 600,
};

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = querySchema.safeParse({
    symbol: searchParams.get('symbol'),
    interval: searchParams.get('interval'),
    limit: searchParams.get('limit') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { symbol, interval, limit } = parsed.data;
  const ttl = TTL_MAP[interval] ?? 60;

  try {
    const data = await cachedFetch(
      `klines:${symbol}:${interval}:${limit}`,
      () => fetchKlines(symbol, interval, limit),
      ttl
    );

    return NextResponse.json(data);
  } catch (error) {
    console.error('Failed to fetch klines:', error);
    return NextResponse.json({ error: 'Failed to fetch price history' }, { status: 500 });
  }
}
