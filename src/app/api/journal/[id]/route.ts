import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { isPositionAction, JournalEntry } from '@/lib/models/journal-entry';
import { updateJournalEntrySchema } from '@/types/journal';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';
import { serializeJournalEntry } from '@/lib/journal/times';
import { deleteScreenshotFile } from '@/lib/journal/screenshots';

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

  return NextResponse.json({ entry: serializeJournalEntry(entry) });
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

  const newEntryPrice =
    (updateData.entryPrice as number | undefined) ?? existing.entryPrice;
  const newExitPrice =
    (updateData.exitPrice as number | undefined) ?? existing.exitPrice;

  // Reject exitPrice when entry has no entryPrice
  if (newExitPrice != null && newEntryPrice == null) {
    return NextResponse.json(
      { error: 'Cannot set exit price on an entry without an entry price' },
      { status: 400 }
    );
  }

  // Auto-compute P&L only for buy/sell actions with both prices
  if (
    ('entryPrice' in updateData || 'exitPrice' in updateData) &&
    newEntryPrice != null &&
    newExitPrice != null &&
    isPositionAction(existing.action)
  ) {
    const entryPrice = newEntryPrice;
    const exitPrice = newExitPrice;
    if (existing.action === 'sell') {
      updateData.outcomePnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
    } else {
      updateData.outcomePnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    }
  }

  // exitedAt (not null) on a hold or skip gives 400 "Only a buy or sell can have an exit time."
  if (updateData.exitedAt != null && !isPositionAction(existing.action)) {
    return NextResponse.json(
      { error: 'Only a buy or sell can have an exit time.' },
      { status: 400 }
    );
  }

  // effectiveEntered and effectiveExited order check
  const effectiveEntered =
    (updateData.enteredAt as Date | undefined) ??
    existing.enteredAt ??
    existing.createdAt;
  const effectiveExited =
    'exitedAt' in updateData
      ? (updateData.exitedAt as Date | null | undefined)
      : existing.exitedAt;

  if (
    effectiveEntered != null &&
    effectiveExited != null &&
    new Date(effectiveExited).getTime() < new Date(effectiveEntered).getTime()
  ) {
    return NextResponse.json(
      { error: 'Exited at must be after entered at.' },
      { status: 400 }
    );
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
    if (!entry) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }
    return NextResponse.json({ entry: serializeJournalEntry(entry) });
  }

  const entry = await JournalEntry.findOneAndUpdate(
    { _id: id, userId: session.user.id },
    mongoUpdate,
    { new: true }
  );

  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  return NextResponse.json({ entry: serializeJournalEntry(entry) });
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
  const result = await JournalEntry.findOneAndDelete({
    _id: id,
    userId: session.user.id,
  });

  if (!result) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  if (Array.isArray(result.screenshots) && result.screenshots.length > 0) {
    for (const screenshot of result.screenshots) {
      try {
        await deleteScreenshotFile(screenshot.fileId);
      } catch (err) {
        console.error('Failed to delete screenshot file:', screenshot.fileId, err);
      }
    }
  }

  return NextResponse.json({ success: true });
}
