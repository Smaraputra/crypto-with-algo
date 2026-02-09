import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { fetchFundingRate } from '@/lib/binance-futures';
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

  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get('limit') || '1', 10),
    100
  );

  try {
    const data = await cachedFetch(
      `futures:funding:${symbol}:${limit}`,
      () => fetchFundingRate(symbol, limit),
      300
    );

    return NextResponse.json({ fundingRates: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch funding rate';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
