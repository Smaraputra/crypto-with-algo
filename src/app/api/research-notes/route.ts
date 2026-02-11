import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { ResearchNote, MAX_RESEARCH_NOTES_PER_USER } from '@/lib/models/research-note';
import { createResearchNoteSchema } from '@/types/research-note';

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
    query.title = { $regex: search, $options: 'i' };
  }

  const pinned = params.get('pinned');
  if (pinned === 'true') query.isPinned = true;

  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(params.get('limit') || '20', 10)));
  const sort = params.get('sort') || '-createdAt';

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
