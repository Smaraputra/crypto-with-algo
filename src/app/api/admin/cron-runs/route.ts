import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { CronRun } from '@/lib/models/cron-run';

export async function GET() {
  try {
    // Auth: Admin-only
    const session = await auth();
    if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();

    // Fetch cron runs, sorted by scheduled date (newest first)
    const runs = await CronRun.find()
      .sort({ scheduledAt: -1 })
      .limit(50)
      .lean();

    // Transform to response format
    const response = runs.map((run) => ({
      id: run._id.toString(),
      type: run.type,
      scheduledAt: run.scheduledAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      jobs: run.jobs,
      summary: run.summary,
      error: run.error,
      createdAt: run.createdAt,
    }));

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching cron runs:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
