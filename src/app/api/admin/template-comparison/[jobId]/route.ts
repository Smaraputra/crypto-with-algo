import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { OptimizationJob } from '@/lib/models/optimization-job';
import { SignalTemplate } from '@/lib/models/signal-template';
import mongoose from 'mongoose';

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    // Auth: Admin-only
    const session = await auth();
    if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { jobId } = await params;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
      return NextResponse.json({ error: 'Invalid job ID' }, { status: 400 });
    }

    await connectDB();

    // Find the optimization job
    const job = await OptimizationJob.findById(jobId);

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'completed' || !job.templateVersion) {
      return NextResponse.json(
        { error: 'Job not completed or no template created' },
        { status: 400 }
      );
    }

    // Find the optimized template (created by this job)
    const optimizedTemplate = await SignalTemplate.findOne({
      tradingStyle: job.tradingStyle,
      version: job.templateVersion,
    });

    if (!optimizedTemplate) {
      return NextResponse.json({ error: 'Optimized template not found' }, { status: 404 });
    }

    // Find the current active template (if any)
    const currentTemplate = await SignalTemplate.findOne({
      tradingStyle: job.tradingStyle,
      active: true,
    });

    // Return comparison data
    return NextResponse.json({
      currentTemplate: currentTemplate
        ? {
            id: currentTemplate._id.toString(),
            tradingStyle: currentTemplate.tradingStyle,
            version: currentTemplate.version,
            weights: currentTemplate.weights,
            thresholds: currentTemplate.thresholds,
            performanceMetrics: currentTemplate.performanceMetrics,
            active: currentTemplate.active,
          }
        : null,
      optimizedTemplate: {
        id: optimizedTemplate._id.toString(),
        tradingStyle: optimizedTemplate.tradingStyle,
        version: optimizedTemplate.version,
        weights: optimizedTemplate.weights,
        thresholds: optimizedTemplate.thresholds,
        performanceMetrics: optimizedTemplate.performanceMetrics,
        active: optimizedTemplate.active,
      },
    });
  } catch (error) {
    console.error('Template comparison error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
