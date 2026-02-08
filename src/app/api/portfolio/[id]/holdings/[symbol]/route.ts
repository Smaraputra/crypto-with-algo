import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Portfolio } from '@/lib/models/portfolio';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; symbol: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id, symbol } = await params;
  await connectDB();

  const portfolio = await Portfolio.findOne({
    _id: id,
    userId: session.user.id,
  });

  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  const holdingIndex = portfolio.holdings.findIndex(
    (h: { symbol: string }) => h.symbol === symbol
  );

  if (holdingIndex === -1) {
    return NextResponse.json({ error: 'Holding not found' }, { status: 404 });
  }

  portfolio.holdings.splice(holdingIndex, 1);
  await portfolio.save();

  return NextResponse.json({ success: true });
}
