import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { fetchGlobalLongShortRatio, fetchLongShortRatio } from '@/lib/binance-futures';
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

  const period = req.nextUrl.searchParams.get('period') || '1h';
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get('limit') || '30', 10),
    500
  );
  const type = req.nextUrl.searchParams.get('type') || 'top'; // 'top' or 'global'

  try {
    const fetcher = type === 'global'
      ? () => fetchGlobalLongShortRatio(symbol, period, limit)
      : () => fetchLongShortRatio(symbol, period, limit);

    const data = await cachedFetch(
      `futures:ls:${type}:${symbol}:${period}:${limit}`,
      fetcher,
      300
    );

    return NextResponse.json({ longShortRatio: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch long/short ratio';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
