import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { Signal } from '@/lib/models/signal';
import { connectDB } from '@/lib/mongodb';
import { SIGNAL_TIERS } from '@/types/signal';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const symbol = req.nextUrl.searchParams.get('symbol');
  const tier = req.nextUrl.searchParams.get('tier');
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get('limit') || '50', 10),
    200
  );

  const query: Record<string, unknown> = { userId: session.user.id };
  if (symbol) query.symbol = symbol;
  if (tier && (SIGNAL_TIERS as readonly string[]).includes(tier)) {
    query.tier = tier;
  }

  const signals = await Signal.find(query)
    .sort({ createdAt: -1 })
    .limit(limit);

  return NextResponse.json({ signals });
}
