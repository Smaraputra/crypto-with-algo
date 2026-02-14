import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { GlobalSignal } from '@/lib/models/global-signal';
import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import { connectDB } from '@/lib/mongodb';
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

  await connectDB();

  const tradingStyleParam = req.nextUrl.searchParams.get('tradingStyle');

  // If specific style requested, return latest for that style only
  if (tradingStyleParam) {
    if (!isValidTradingStyle(tradingStyleParam)) {
      return NextResponse.json(
        { error: `Invalid trading style: ${tradingStyleParam}` },
        { status: 400 }
      );
    }

    const signal = await GlobalSignal.findOne({
      symbol,
      tradingStyle: tradingStyleParam,
    })
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({ signal });
  }

  // No style specified: return latest for each style
  const styles: TradingStyle[] = [...TRADING_STYLES];
  const results: Record<string, unknown> = {};

  await Promise.all(
    styles.map(async (style) => {
      const signal = await GlobalSignal.findOne({
        symbol,
        tradingStyle: style,
      })
        .sort({ createdAt: -1 })
        .lean();
      results[style] = signal ?? null;
    })
  );

  return NextResponse.json({ signals: results });
}
