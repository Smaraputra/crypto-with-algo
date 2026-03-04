import { NextRequest, NextResponse } from 'next/server';
import { fetchSymbols } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const limiter = createRateLimiter(30, 60);

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req, limiter);
  if (limited) return limited;
  try {
    const symbols = await cachedFetch(
      'symbols:usdt',
      () => fetchSymbols(),
      3600
    );

    return NextResponse.json(symbols);
  } catch (error) {
    console.error('Failed to fetch symbols:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Failed to fetch symbols' }, { status: 500 });
  }
}
