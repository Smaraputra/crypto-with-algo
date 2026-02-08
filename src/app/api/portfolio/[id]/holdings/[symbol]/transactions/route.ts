import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Portfolio } from '@/lib/models/portfolio';
import { calculateHoldingState } from '@/lib/portfolio-utils';

const transactionSchema = z.object({
  type: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  price: z.number().nonnegative(),
  date: z.string().optional(),
  notes: z.string().optional(),
  fee: z.number().nonnegative().optional(),
});

export async function GET(
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

  const holding = portfolio.holdings.find(
    (h: { symbol: string }) => h.symbol === symbol
  );

  if (!holding) {
    return NextResponse.json({ error: 'Holding not found' }, { status: 404 });
  }

  const sorted = [...holding.transactions].sort(
    (a: { date: Date }, b: { date: Date }) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return NextResponse.json({ transactions: sorted });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; symbol: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = transactionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
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

  const holding = portfolio.holdings.find(
    (h: { symbol: string }) => h.symbol === symbol
  );

  if (!holding) {
    return NextResponse.json({ error: 'Holding not found' }, { status: 404 });
  }

  const { type, quantity, price, date, notes, fee } = parsed.data;

  if (type === 'sell' && quantity > holding.quantity) {
    return NextResponse.json(
      { error: 'Sell quantity exceeds held quantity' },
      { status: 400 }
    );
  }

  const transaction = {
    type,
    quantity,
    price,
    date: date ? new Date(date) : new Date(),
    notes,
    fee: fee ?? 0,
  };

  holding.transactions.push(transaction);
  const state = calculateHoldingState(holding.transactions);
  holding.quantity = state.quantity;
  holding.avgBuyPrice = state.avgBuyPrice;

  await portfolio.save();

  return NextResponse.json({ portfolio });
}
