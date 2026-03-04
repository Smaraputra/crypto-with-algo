import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { BacktestResultV2 } from '@/lib/models/backtest-result-v2';
import { Strategy } from '@/lib/models/strategy';
import { saveBacktestResultSchema } from '@/types/backtest';
import { compressBacktestResult } from '@/lib/backtest/compress-results';
import type { BacktestResult } from '@/lib/backtest/types';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const { searchParams } = new URL(req.url);
  const strategyId = searchParams.get('strategyId');
  const tradingStyle = searchParams.get('tradingStyle');
  const symbol = searchParams.get('symbol');

  const filter: Record<string, unknown> = { userId: session.user.id };
  if (strategyId) filter.strategyId = strategyId;
  if (tradingStyle) filter.tradingStyle = tradingStyle;
  if (symbol) filter.symbol = symbol;

  // Return summaries without equityCurve for performance
  const results = await BacktestResultV2.find(filter)
    .select('-equityCurveSampled -config')
    .sort({ createdAt: -1 })
    .limit(100); // Limit to last 100 for UI performance

  return NextResponse.json({ results });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  const body = await req.json();
  const parsed = saveBacktestResultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();

  // Get strategy to determine trading style and template
  let tradingStyle = 'day_trading'; // Default
  let templateId: string | null = null;

  if (parsed.data.strategyId) {
    const strategy = await Strategy.findOne({
      _id: parsed.data.strategyId,
      userId: session.user.id,
    });

    if (strategy) {
      tradingStyle = strategy.tradingStyle;
      templateId = strategy.templateId?.toString() || null;
    }
  }

  // Compress the backtest result
  const backtestResult: BacktestResult = {
    symbol: parsed.data.symbol,
    interval: parsed.data.interval,
    startTime: parsed.data.startTime,
    endTime: parsed.data.endTime,
    totalBars: parsed.data.totalBars,
    warmupBars: parsed.data.warmupBars,
    config: parsed.data.config as never,
    metrics: parsed.data.metrics as never,
    trades: (parsed.data.trades || []) as never,
    equityCurve: (parsed.data.equityCurve || []) as never,
  };

  const compressed = compressBacktestResult(
    backtestResult,
    session.user.id,
    parsed.data.strategyId || null,
    tradingStyle as never
  );

  if (templateId) {
    compressed.templateId = templateId as never;
  }

  const result = await BacktestResultV2.create(compressed);

  return NextResponse.json({ result }, { status: 201 });
}
