import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Watchlist } from '@/lib/models/watchlist';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';

const updateSchema = z.object({
  symbols: z.array(z.string().min(1)).max(50),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();
  let watchlist = await Watchlist.findOne({ userId: session.user.id });
  if (!watchlist) {
    watchlist = await Watchlist.create({ userId: session.user.id });
  }

  return NextResponse.json({ symbols: watchlist.symbols });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();
  const watchlist = await Watchlist.findOneAndUpdate(
    { userId: session.user.id },
    { symbols: parsed.data.symbols },
    { new: true, upsert: true }
  );

  return NextResponse.json({ symbols: watchlist.symbols });
}
