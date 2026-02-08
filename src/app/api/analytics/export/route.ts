import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Portfolio, type IHolding } from '@/lib/models/portfolio';
import { computeHoldingCostBasis } from '@/lib/cost-basis';
import { generateTaxCsv } from '@/lib/csv-export';
import type { CostBasisMethod } from '@/types/analytics';

const querySchema = z.object({
  portfolioId: z.string().min(1),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  method: z.enum(['fifo', 'lifo', 'hifo']).default('fifo'),
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

  const { portfolioId, year, method } = parsed.data;
  await connectDB();

  const portfolio = await Portfolio.findOne({
    _id: portfolioId,
    userId: session.user.id,
  });
  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  const holdingsData = portfolio.holdings.map((h: IHolding) => {
    const costBasis = computeHoldingCostBasis(h.transactions, h.symbol, method as CostBasisMethod);
    return {
      symbol: h.symbol,
      transactions: h.transactions,
      realizedGains: costBasis.realizedGains,
    };
  });

  const csv = generateTaxCsv(holdingsData, year);
  const filename = year ? `tax-report-${year}.csv` : 'tax-report.csv';

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
