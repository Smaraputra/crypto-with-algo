import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry } from '@/lib/models/journal-entry';
import { updateJournalEntrySchema } from '@/types/journal';

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
  const entry = await JournalEntry.findOne({
    _id: id,
    userId: session.user.id,
  });

  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  return NextResponse.json({ entry });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = updateJournalEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { id } = await params;
  await connectDB();

  const updateData = { ...parsed.data } as Record<string, unknown>;

  const existing = await JournalEntry.findOne({
    _id: id,
    userId: session.user.id,
  });

  if (!existing) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  // Reject exitPrice when entry has no entryPrice
  if (updateData.exitPrice != null && existing.entryPrice == null) {
    return NextResponse.json(
      { error: 'Cannot set exit price on an entry without an entry price' },
      { status: 400 }
    );
  }

  // Auto-compute P&L only for buy/sell actions with both prices
  if (
    updateData.exitPrice != null &&
    existing.entryPrice != null &&
    (existing.action === 'buy' || existing.action === 'sell')
  ) {
    const entryPrice = existing.entryPrice;
    const exitPrice = updateData.exitPrice as number;
    if (existing.action === 'sell') {
      updateData.outcomePnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
    } else {
      updateData.outcomePnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    }
  }

  // Preserve review history when overwriting lessonsLearned
  const mongoUpdate: Record<string, unknown> = { ...updateData };
  if (
    updateData.lessonsLearned != null &&
    existing.lessonsLearned &&
    existing.reviewedAt
  ) {
    delete mongoUpdate.$push;
    const pushOp = {
      reviewHistory: {
        lessonsLearned: existing.lessonsLearned,
        reviewedAt: existing.reviewedAt,
      },
    };
    const entry = await JournalEntry.findOneAndUpdate(
      { _id: id, userId: session.user.id },
      { $set: mongoUpdate, $push: pushOp },
      { new: true }
    );
    return NextResponse.json({ entry });
  }

  const entry = await JournalEntry.findOneAndUpdate(
    { _id: id, userId: session.user.id },
    mongoUpdate,
    { new: true }
  );

  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  return NextResponse.json({ entry });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  await connectDB();
  const result = await JournalEntry.findOneAndDelete({
    _id: id,
    userId: session.user.id,
  });

  if (!result) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
