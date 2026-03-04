import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { auth } from '@/lib/auth';
import { CronRun } from '@/lib/models/cron-run';
import { verifyCronSecret } from '@/lib/cron-auth';

interface RouteParams {
  params: Promise<{
    cronRunId: string;
  }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { cronRunId } = await params;

    // Auth: Admin or CRON_SECRET
    if (!verifyCronSecret(req)) {
      const session = await auth();
      if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    await connectDB();

    const cronRun = await CronRun.findById(cronRunId);

    if (!cronRun) {
      return NextResponse.json({ error: 'Cron run not found' }, { status: 404 });
    }

    // Calculate progress
    const totalJobs = cronRun.jobs.length;
    const completedJobs = cronRun.jobs.filter((j) => j.status === 'completed').length;
    const failedJobs = cronRun.jobs.filter((j) => j.status === 'failed').length;
    const finishedJobs = completedJobs + failedJobs;
    const percent = totalJobs > 0 ? Math.round((finishedJobs / totalJobs) * 100) : 0;

    // Estimate time remaining
    let estimatedTimeRemaining = 0;
    if (cronRun.status === 'running' && cronRun.startedAt) {
      const elapsed = Date.now() - new Date(cronRun.startedAt).getTime();
      const avgTimePerJob = finishedJobs > 0 ? elapsed / finishedJobs : 0;
      const remainingJobs = totalJobs - finishedJobs;
      estimatedTimeRemaining = Math.round((avgTimePerJob * remainingJobs) / 1000); // seconds
    }

    return NextResponse.json({
      job: cronRun,
      progress: {
        percent,
        currentJob: finishedJobs + 1,
        totalJobs,
        completedJobs,
        failedJobs,
        activatedTemplates: cronRun.summary.activatedTemplates,
        estimatedTimeRemaining,
      },
    });
  } catch (error) {
    console.error('Cron status error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
