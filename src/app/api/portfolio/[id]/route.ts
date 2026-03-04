import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Portfolio } from '@/lib/models/portfolio';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';

const renameSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  return NextResponse.json({ portfolio });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  const body = await req.json();
  const parsed = renameSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { id } = await params;
  await connectDB();

  const duplicate = await Portfolio.findOne({
    userId: session.user.id,
    name: parsed.data.name,
    _id: { $ne: id },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: 'Portfolio with this name already exists' },
      { status: 409 }
    );
  }

  const portfolio = await Portfolio.findOneAndUpdate(
    { _id: id, userId: session.user.id },
    { name: parsed.data.name },
    { new: true }
  );

  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  return NextResponse.json({ portfolio });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  const { id } = await params;
  await connectDB();
  const result = await Portfolio.findOneAndDelete({
    _id: id,
    userId: session.user.id,
  });

  if (!result) {
    return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
