import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry } from '@/lib/models/journal-entry';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const result = await JournalEntry.aggregate([
    { $match: { userId: session.user.id } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  const tags = result.map((r: { _id: string; count: number }) => ({
    tag: r._id,
    count: r.count,
  }));

  return NextResponse.json({ tags });
}
