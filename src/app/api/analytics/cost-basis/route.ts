import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Portfolio, type IHolding } from '@/lib/models/portfolio';
import { computeHoldingCostBasis } from '@/lib/cost-basis';
import type { CostBasisResult, CostBasisHolding } from '@/types/analytics';

const querySchema = z.object({
  portfolioId: z.string().min(1),
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

  const { portfolioId } = parsed.data;
  await connectDB();

  const portfolio = await Portfolio.findOne({
    _id: portfolioId,
    userId: session.user.id,
  });
  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  const holdings: CostBasisHolding[] = portfolio.holdings.map((h: IHolding) =>
    computeHoldingCostBasis(h.transactions, h.symbol)
  );

  const costBasis: CostBasisResult = {
    holdings,
    totalRealizedGain: holdings.reduce((s: number, h: CostBasisHolding) => s + h.totalRealizedGain, 0),
    totalUnrealizedCostBasis: holdings.reduce((s: number, h: CostBasisHolding) => s + h.totalCost, 0),
  };

  return NextResponse.json({ costBasis });
}
