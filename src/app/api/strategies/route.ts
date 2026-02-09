import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Strategy, MAX_STRATEGIES_PER_USER } from '@/lib/models/strategy';
import { createStrategySchema } from '@/types/strategy';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();
  const strategies = await Strategy.find({ userId: session.user.id }).sort({ createdAt: -1 });
  return NextResponse.json({ strategies });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createStrategySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();

  const count = await Strategy.countDocuments({ userId: session.user.id });
  if (count >= MAX_STRATEGIES_PER_USER) {
    return NextResponse.json(
      { error: `Maximum of ${MAX_STRATEGIES_PER_USER} strategies per user` },
      { status: 400 }
    );
  }

  const strategy = await Strategy.create({
    userId: session.user.id,
    ...parsed.data,
  });

  return NextResponse.json({ strategy }, { status: 201 });
}
