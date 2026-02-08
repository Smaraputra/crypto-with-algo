import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Portfolio } from '@/lib/models/portfolio';
import { calculateHoldingState } from '@/lib/portfolio-utils';

const addHoldingSchema = z.object({
  symbol: z.string().min(1),
  baseAsset: z.string().min(1),
  quoteAsset: z.string().min(1),
  type: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  price: z.number().nonnegative(),
  date: z.string().optional(),
  notes: z.string().optional(),
  fee: z.number().nonnegative().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = addHoldingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { id } = await params;
  await connectDB();

  const portfolio = await Portfolio.findOne({
    _id: id,
    userId: session.user.id,
  });

  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  const { symbol, baseAsset, quoteAsset, type, quantity, price, date, notes, fee } = parsed.data;
  const transaction = {
    type,
    quantity,
    price,
    date: date ? new Date(date) : new Date(),
    notes,
    fee: fee ?? 0,
  };

  const existingHolding = portfolio.holdings.find((h: { symbol: string }) => h.symbol === symbol);

  if (existingHolding) {
    if (type === 'sell' && quantity > existingHolding.quantity) {
      return NextResponse.json(
        { error: 'Sell quantity exceeds held quantity' },
        { status: 400 }
      );
    }
    existingHolding.transactions.push(transaction);
    const state = calculateHoldingState(existingHolding.transactions);
    existingHolding.quantity = state.quantity;
    existingHolding.avgBuyPrice = state.avgBuyPrice;
  } else {
    if (type === 'sell') {
      return NextResponse.json(
        { error: 'Cannot sell an asset you do not hold' },
        { status: 400 }
      );
    }
    const state = calculateHoldingState([transaction]);
    portfolio.holdings.push({
      symbol,
      baseAsset,
      quoteAsset,
      quantity: state.quantity,
      avgBuyPrice: state.avgBuyPrice,
      transactions: [transaction],
    });
  }

  await portfolio.save();

  return NextResponse.json({ portfolio }, { status: 200 });
}
