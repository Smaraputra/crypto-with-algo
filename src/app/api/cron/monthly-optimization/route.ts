import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { CronRun } from '@/lib/models/cron-run';
import { getTopSymbols } from '@/lib/optimization/top-symbols';
import { runMonthlyOptimization } from '@/lib/optimization/monthly-orchestrator';
import { verifyCronSecret } from '@/lib/cron-auth';

export async function POST(req: NextRequest) {
  try {
    // 1. Verify authorization header
    if (!verifyCronSecret(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();

    // 2. Check for existing running job
    const existingRun = await CronRun.findOne({
      type: 'monthly_optimization',
      status: 'running',
    });

    if (existingRun) {
      return NextResponse.json(
        {
          message: 'Optimization already running',
          cronRunId: existingRun._id.toString(),
        },
        { status: 409 }
      );
    }

    // 3. Create CronRun document
    const cronRun = await CronRun.create({
      type: 'monthly_optimization',
      scheduledAt: new Date(),
      status: 'scheduled',
      jobs: [
        { tradingStyle: 'scalping', status: 'pending' },
        { tradingStyle: 'day_trading', status: 'pending' },
        { tradingStyle: 'swing_trading', status: 'pending' },
        { tradingStyle: 'position_trading', status: 'pending' },
      ],
      summary: {
        totalJobs: 4,
        completedJobs: 0,
        failedJobs: 0,
        activatedTemplates: 0,
      },
    });

    // 4. Fetch top symbols
    const topSymbols = await getTopSymbols(5);

    // 5. Start background job (don't await - return immediately)
    runMonthlyOptimization({
      cronRunId: cronRun._id,
      topSymbols,
      months: 6,
      autoActivate: true,
    }).catch(async (error) => {
      // Log error to CronRun
      console.error('Monthly optimization error:', error instanceof Error ? error.message : 'Unknown error');
      await CronRun.updateOne(
        { _id: cronRun._id },
        {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        }
      );
    });

    // 6. Return immediately
    return NextResponse.json({
      message: 'Monthly optimization started',
      cronRunId: cronRun._id.toString(),
      topSymbols,
    });
  } catch (error) {
    console.error('Cron endpoint error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
