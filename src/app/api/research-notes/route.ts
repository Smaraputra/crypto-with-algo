import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { ResearchNote, MAX_RESEARCH_NOTES_PER_USER } from '@/lib/models/research-note';
import { createResearchNoteSchema } from '@/types/research-note';
import { escapeRegex } from '@/lib/utils';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const params = req.nextUrl.searchParams;
  const query: Record<string, unknown> = { userId: session.user.id };

  const category = params.get('category');
  if (category) query.category = category;

  const tag = params.get('tag');
  if (tag) query.tags = tag;

  const search = params.get('search');
  if (search) {
    query.title = { $regex: escapeRegex(search), $options: 'i' };
  }

  const pinned = params.get('pinned');
  if (pinned === 'true') query.isPinned = true;

  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(params.get('limit') || '20', 10) || 1));

  const ALLOWED_SORT_FIELDS = ['createdAt', 'updatedAt', 'title', 'category'];
  const rawSort = params.get('sort') || '-createdAt';
  const sortField = rawSort.startsWith('-') ? rawSort.slice(1) : rawSort;
  const sort = ALLOWED_SORT_FIELDS.includes(sortField) ? rawSort : '-createdAt';

  const sortObj: Record<string, 1 | -1> = {};
  if (sort.startsWith('-')) {
    sortObj[sort.slice(1)] = -1;
  } else {
    sortObj[sort] = 1;
  }

  const [notes, total] = await Promise.all([
    ResearchNote.find(query)
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit),
    ResearchNote.countDocuments(query),
  ]);

  return NextResponse.json({
    notes,
    total,
    page,
    totalPages: Math.ceil(total / limit),
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
  const parsed = createResearchNoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();

  const count = await ResearchNote.countDocuments({ userId: session.user.id });
  if (count >= MAX_RESEARCH_NOTES_PER_USER) {
    return NextResponse.json(
      { error: `Maximum of ${MAX_RESEARCH_NOTES_PER_USER} research notes per user` },
      { status: 400 }
    );
  }

  const note = await ResearchNote.create({
    userId: session.user.id,
    ...parsed.data,
  });

  return NextResponse.json({ note }, { status: 201 });
}
