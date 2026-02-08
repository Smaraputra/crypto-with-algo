import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Portfolio } from '@/lib/models/portfolio';

const createSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();
  let portfolios = await Portfolio.find(
    { userId: session.user.id },
    { name: 1, holdings: 1, createdAt: 1, updatedAt: 1 }
  ).sort({ createdAt: 1 });

  if (portfolios.length === 0) {
    const defaultPortfolio = await Portfolio.create({ userId: session.user.id });
    portfolios = [defaultPortfolio];
  }

  const items = portfolios.map((p) => ({
    _id: p._id,
    name: p.name,
    holdingsCount: p.holdings.length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  return NextResponse.json({ portfolios: items });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();
  const existing = await Portfolio.findOne({
    userId: session.user.id,
    name: parsed.data.name,
  });
  if (existing) {
    return NextResponse.json(
      { error: 'Portfolio with this name already exists' },
      { status: 409 }
    );
  }

  const portfolio = await Portfolio.create({
    userId: session.user.id,
    name: parsed.data.name,
  });

  return NextResponse.json(
    {
      portfolio: {
        _id: portfolio._id,
        name: portfolio.name,
        holdingsCount: 0,
        createdAt: portfolio.createdAt,
        updatedAt: portfolio.updatedAt,
      },
    },
    { status: 201 }
  );
}
