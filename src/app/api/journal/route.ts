import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry, MAX_JOURNAL_ENTRIES_PER_USER, POSITION_ACTIONS } from '@/lib/models/journal-entry';
import { createJournalEntrySchema } from '@/types/journal';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';
import { EFFECTIVE_ENTERED_AT, serializeJournalEntry } from '@/lib/journal/times';
import type { PipelineStage } from 'mongoose';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const params = req.nextUrl.searchParams;
  const matchFilter: Record<string, unknown> = { userId: session.user.id };

  const symbol = params.get('symbol');
  if (symbol) matchFilter.symbol = symbol;

  const tag = params.get('tag');
  if (tag) matchFilter.tags = tag;

  const action = params.get('action');
  if (action) matchFilter.action = action;

  const setupType = params.get('setupType');
  if (setupType) matchFilter.setupType = setupType;

  const marketCondition = params.get('marketCondition');
  if (marketCondition) matchFilter.marketCondition = marketCondition;

  // Trade status filter: open = has entryPrice but no exitPrice, closed = has exitPrice
  const status = params.get('status');
  // Both branches key on POSITION_ACTIONS for the same reason the analytics
  // route does: a hold or skip is not a trade, so it belongs in neither the open
  // nor the closed list however its prices are filled in.
  if (status === 'open') {
    matchFilter.action = { $in: POSITION_ACTIONS };
    matchFilter.entryPrice = { $ne: null };
    matchFilter.exitPrice = null;
  } else if (status === 'closed') {
    matchFilter.action = { $in: POSITION_ACTIONS };
    matchFilter.exitPrice = { $ne: null };
  }

  const startDate = params.get('startDate');
  const endDate = params.get('endDate');
  const dateFilter: Record<string, Date> = {};
  if (startDate) dateFilter.$gte = new Date(startDate);
  if (endDate) dateFilter.$lte = new Date(endDate);
  const hasDateFilter = startDate != null || endDate != null;

  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '50', 10) || 1));

  const ALLOWED_SORT_FIELDS = [
    'createdAt',
    'updatedAt',
    'symbol',
    'action',
    'entryPrice',
    'exitPrice',
    'enteredAt',
    'exitedAt',
  ];
  const rawSort = params.get('sort') || '-enteredAt';
  const sortField = rawSort.startsWith('-') ? rawSort.slice(1) : rawSort;
  const sort = ALLOWED_SORT_FIELDS.includes(sortField) ? rawSort : '-enteredAt';

  const sortStage: Record<string, 1 | -1> = {};
  if (sort.startsWith('-')) {
    sortStage[sort.slice(1)] = -1;
  } else {
    sortStage[sort] = 1;
  }
  sortStage._id = -1;

  const pipeline: Record<string, unknown>[] = [
    { $match: matchFilter },
    {
      $addFields: {
        enteredAt: EFFECTIVE_ENTERED_AT,
        exitedAt: { $ifNull: ['$exitedAt', null] },
        screenshots: { $ifNull: ['$screenshots', []] },
      },
    },
  ];

  if (hasDateFilter) {
    pipeline.push({ $match: { enteredAt: dateFilter } });
  }

  pipeline.push({
    $facet: {
      entries: [
        { $sort: sortStage },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ],
      total: [{ $count: 'n' }],
    },
  });

  const [aggResult, totalUserEntries] = await Promise.all([
    JournalEntry.aggregate(pipeline as unknown as PipelineStage[]),
    JournalEntry.countDocuments({ userId: session.user.id }),
  ]);

  const facetResult = (aggResult[0] as {
    entries: unknown[];
    total: { n: number }[];
  }) ?? { entries: [], total: [] };

  const entries = facetResult.entries;
  const total = facetResult.total[0]?.n ?? 0;

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

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

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
    enteredAt: parsed.data.enteredAt ?? new Date(),
  });

  return NextResponse.json({ entry: serializeJournalEntry(entry) }, { status: 201 });
}
