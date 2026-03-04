import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { OptimizationJob } from '@/lib/models/optimization-job';

export async function GET() {
  try {
    // Auth: Admin-only
    const session = await auth();
    if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();

    // Fetch all jobs, sorted by creation date (newest first)
    const jobs = await OptimizationJob.find()
      .sort({ createdAt: -1 })
      .limit(100) // Limit to last 100 jobs
      .lean();

    // Transform to response format
    const response = jobs.map((job) => ({
      id: job._id.toString(),
      tradingStyle: job.tradingStyle,
      symbol: job.symbol,
      interval: job.interval,
      status: job.status,
      templateVersion: job.templateVersion,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      progress: {
        candidatesTested: job.progress.candidatesTested,
        validResults: job.progress.validResults,
      },
    }));

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching optimization jobs:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
