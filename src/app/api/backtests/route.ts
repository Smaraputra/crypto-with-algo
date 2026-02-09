import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { BacktestResult, MAX_BACKTEST_RESULTS_PER_USER } from '@/lib/models/backtest-result';
import { saveBacktestResultSchema } from '@/types/backtest';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  // Return summaries without equityCurve and trades for performance
  const results = await BacktestResult.find({ userId: session.user.id })
    .select('-trades -equityCurve -config')
    .sort({ createdAt: -1 });

  return NextResponse.json({ results });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = saveBacktestResultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();

  const count = await BacktestResult.countDocuments({ userId: session.user.id });
  if (count >= MAX_BACKTEST_RESULTS_PER_USER) {
    return NextResponse.json(
      { error: `Maximum of ${MAX_BACKTEST_RESULTS_PER_USER} saved backtest results per user` },
      { status: 400 }
    );
  }

  const result = await BacktestResult.create({
    userId: session.user.id,
    ...parsed.data,
  });

  return NextResponse.json({ result }, { status: 201 });
}
