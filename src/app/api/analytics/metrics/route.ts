import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { PortfolioSnapshot } from '@/lib/models/portfolio-snapshot';
import { Portfolio } from '@/lib/models/portfolio';
import { computeRiskMetrics } from '@/lib/risk-metrics';

const querySchema = z.object({
  portfolioId: z.string().min(1),
  range: z.coerce.number().int().min(1).max(365).default(90),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { portfolioId, range } = parsed.data;
  await connectDB();

  const portfolio = await Portfolio.findOne({
    _id: portfolioId,
    userId: session.user.id,
  });
  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - range);
  startDate.setUTCHours(0, 0, 0, 0);

  const snapshots = await PortfolioSnapshot.find({
    portfolioId,
    date: { $gte: startDate },
  }).sort({ date: 1 });

  const dataPoints = snapshots.map((s) => ({
    date: s.date.toISOString(),
    totalValue: s.totalValue,
  }));

  const metrics = computeRiskMetrics(dataPoints);
  const minRequired = 30;

  return NextResponse.json({
    metrics,
    insufficientData: metrics === null || metrics.sharpeRatio === null,
    dataPoints: snapshots.length,
    minRequired,
  });
}
