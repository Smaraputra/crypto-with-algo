import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { fetchOpenInterest, fetchOpenInterestHistory } from '@/lib/binance-futures';
import { cachedFetch } from '@/lib/redis';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol parameter is required' },
      { status: 400 }
    );
  }

  const includeHistory = req.nextUrl.searchParams.get('history') === 'true';

  try {
    const current = await cachedFetch(
      `futures:oi:${symbol}`,
      () => fetchOpenInterest(symbol),
      60
    );

    let history = null;
    if (includeHistory) {
      const period = req.nextUrl.searchParams.get('period') || '5m';
      const limit = Math.min(
        parseInt(req.nextUrl.searchParams.get('limit') || '30', 10),
        500
      );

      history = await cachedFetch(
        `futures:oi-hist:${symbol}:${period}:${limit}`,
        () => fetchOpenInterestHistory(symbol, period, limit),
        300
      );
    }

    return NextResponse.json({ openInterest: current, history });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch open interest';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
