import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry, MAX_JOURNAL_ENTRIES_PER_USER } from '@/lib/models/journal-entry';
import { createJournalEntrySchema } from '@/types/journal';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const symbolFilter = req.nextUrl.searchParams.get('symbol');
  const query: Record<string, string> = { userId: session.user.id };
  if (symbolFilter) {
    query.symbol = symbolFilter;
  }

  const entries = await JournalEntry.find(query).sort({ createdAt: -1 }).limit(100);
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createJournalEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();

  const count = await JournalEntry.countDocuments({ userId: session.user.id });
  if (count >= MAX_JOURNAL_ENTRIES_PER_USER) {
    return NextResponse.json(
      { error: `Maximum of ${MAX_JOURNAL_ENTRIES_PER_USER} journal entries per user` },
      { status: 400 }
    );
  }

  const entry = await JournalEntry.create({
    userId: session.user.id,
    ...parsed.data,
  });

  return NextResponse.json({ entry }, { status: 201 });
}
