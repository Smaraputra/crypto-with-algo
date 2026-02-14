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

  const params = req.nextUrl.searchParams;
  const query: Record<string, unknown> = { userId: session.user.id };

  const symbol = params.get('symbol');
  if (symbol) query.symbol = symbol;

  const tag = params.get('tag');
  if (tag) query.tags = tag;

  const action = params.get('action');
  if (action) query.action = action;

  const setupType = params.get('setupType');
  if (setupType) query.setupType = setupType;

  const marketCondition = params.get('marketCondition');
  if (marketCondition) query.marketCondition = marketCondition;

  // Trade status filter: open = has entryPrice but no exitPrice, closed = has exitPrice
  const status = params.get('status');
  if (status === 'open') {
    query.entryPrice = { $ne: null };
    query.exitPrice = null;
  } else if (status === 'closed') {
    query.exitPrice = { $ne: null };
  }

  const startDate = params.get('startDate');
  const endDate = params.get('endDate');
  if (startDate || endDate) {
    const dateFilter: Record<string, Date> = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    query.createdAt = dateFilter;
  }

  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '50', 10)));
  const sort = params.get('sort') || '-createdAt';

  const sortObj: Record<string, 1 | -1> = {};
  if (sort.startsWith('-')) {
    sortObj[sort.slice(1)] = -1;
  } else {
    sortObj[sort] = 1;
  }

  const [entries, total, totalUserEntries] = await Promise.all([
    JournalEntry.find(query)
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit),
    JournalEntry.countDocuments(query),
    JournalEntry.countDocuments({ userId: session.user.id }),
  ]);

  return NextResponse.json({
    entries,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    entryLimit: MAX_JOURNAL_ENTRIES_PER_USER,
    totalUserEntries,
  });
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
