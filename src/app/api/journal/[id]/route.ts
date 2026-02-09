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

  const entry = await JournalEntry.findOneAndUpdate(
    { _id: id, userId: session.user.id },
    parsed.data,
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
