import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { GlobalSignal } from '@/lib/models/global-signal';
import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import { connectDB } from '@/lib/mongodb';
import { SIGNAL_TIERS } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';

function isValidTradingStyle(style: string): style is TradingStyle {
  return (TRADING_STYLES as readonly string[]).includes(style);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol query parameter is required' },
      { status: 400 }
    );
  }

  const tradingStyle = req.nextUrl.searchParams.get('tradingStyle');
  const interval = req.nextUrl.searchParams.get('interval');
  const tier = req.nextUrl.searchParams.get('tier');
  const from = req.nextUrl.searchParams.get('from');
  const to = req.nextUrl.searchParams.get('to');
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get('limit') || '50', 10),
    200
  );

  await connectDB();

  const query: Record<string, unknown> = { symbol };

  if (tradingStyle) {
    if (!isValidTradingStyle(tradingStyle)) {
      return NextResponse.json(
        { error: `Invalid trading style: ${tradingStyle}` },
        { status: 400 }
      );
    }
    query.tradingStyle = tradingStyle;
  }

  if (interval) {
    query.interval = interval;
  }

  if (tier && (SIGNAL_TIERS as readonly string[]).includes(tier)) {
    query.tier = tier;
  }

  if (from || to) {
    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.$gte = new Date(parseInt(from, 10));
    if (to) dateFilter.$lte = new Date(parseInt(to, 10));
    query.createdAt = dateFilter;
  }

  const signals = await GlobalSignal.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return NextResponse.json({ signals });
}
