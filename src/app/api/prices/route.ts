import { NextRequest, NextResponse } from 'next/server';
import { fetchTickers } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const TOP_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'MATICUSDT', 'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT',
];

const limiter = createRateLimiter(30, 60);

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req, limiter);
  if (limited) return limited;
  try {
    const tickers = await cachedFetch('tickers:top', async () => {
      const all = await fetchTickers();
      return all.filter((t) => TOP_SYMBOLS.includes(t.symbol));
    }, 30);

    return NextResponse.json(tickers, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    console.error('Failed to fetch tickers:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Failed to fetch prices' }, { status: 500 });
  }
}
