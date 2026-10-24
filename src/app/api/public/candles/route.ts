import { NextRequest, NextResponse } from 'next/server';
import { fetchKlines } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const limiter = createRateLimiter(30, 60);

const ALLOWED_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT']);

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req, limiter);
  if (limited) return limited;

  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get('symbol');
  if (!symbol || !ALLOWED_SYMBOLS.has(symbol)) {
    return NextResponse.json({ error: 'Unsupported symbol' }, { status: 400 });
  }

  const interval = searchParams.get('interval');
  if (interval !== '1h') {
    return NextResponse.json({ error: 'Unsupported interval' }, { status: 400 });
  }

  const limitParam = searchParams.get('limit');
  let limit = 48;
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    const parsed = parseInt(limitParam, 10);
    if (parsed < 1 || parsed > 200) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    limit = parsed;
  }

  try {
    const cacheKey = `public-candles:${symbol}:${interval}:${limit}`;
    const candles = await cachedFetch(
      cacheKey,
      async () => {
        const klines = await fetchKlines(symbol, interval, limit);
        return klines.map((k) => ({
          t: k.timestamp,
          o: k.open,
          h: k.high,
          l: k.low,
          c: k.close,
          v: k.volume,
        }));
      },
      60
    );

    return NextResponse.json(candles, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch (error) {
    console.error(
      'Failed to fetch public candles:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Market data is unavailable' },
      { status: 502 }
    );
  }
}
