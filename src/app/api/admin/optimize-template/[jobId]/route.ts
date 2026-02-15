import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { OptimizationJob } from '@/lib/models/optimization-job';
import mongoose from 'mongoose';

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    // 1. Auth: Admin-only
    const session = await auth();
    if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { jobId } = await params;

    // 2. Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
      return NextResponse.json({ error: 'Invalid job ID' }, { status: 400 });
    }

    await connectDB();

    // 3. Find job
    const job = await OptimizationJob.findById(jobId);

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // 4. Calculate progress percentage
    const percent =
      job.progress.totalWindows > 0
        ? Math.round((job.progress.currentWindow / job.progress.totalWindows) * 100)
        : 0;

    // 5. Estimate time remaining
    let estimatedTimeRemaining = 0;
    if (job.status === 'running' && job.startedAt) {
      const elapsed = Date.now() - job.startedAt.getTime();
      const progressFraction = job.progress.currentWindow / job.progress.totalWindows;

      if (progressFraction > 0) {
        const totalEstimated = elapsed / progressFraction;
        estimatedTimeRemaining = Math.round((totalEstimated - elapsed) / 1000); // seconds
      }
    }

    // 6. Return job status
    return NextResponse.json({
      job: {
        id: job._id.toString(),
        tradingStyle: job.tradingStyle,
        symbol: job.symbol,
        interval: job.interval,
        status: job.status,
        error: job.error,
        optimizedWeights: job.optimizedWeights,
        templateVersion: job.templateVersion,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
      },
      progress: {
        percent,
        currentWindow: job.progress.currentWindow,
        totalWindows: job.progress.totalWindows,
        candidatesTested: job.progress.candidatesTested,
        validResults: job.progress.validResults,
        estimatedTimeRemaining,
      },
    });
  } catch (error) {
    console.error('Job status error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
