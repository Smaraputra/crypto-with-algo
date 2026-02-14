import { NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/mongodb';
import { auth } from '@/lib/auth';
import { CronRun } from '@/lib/models/cron-run';
import { getTopSymbols, FALLBACK_SYMBOLS } from '@/lib/optimization/top-symbols';
import { runMonthlyOptimization } from '@/lib/optimization/monthly-orchestrator';

const requestSchema = z.object({
  symbols: z.array(z.string()).min(1).max(10).optional(),
  months: z.number().min(1).max(12).optional(),
  autoActivate: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    // Auth: Admin only
    const session = await auth();
    if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();

    // Parse and validate request
    const body = await req.json();
    const validation = requestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request', issues: validation.error.issues },
        { status: 400 }
      );
    }

    const { symbols, months = 6, autoActivate = true } = validation.data;

    // Check for existing running job
    const existingRun = await CronRun.findOne({
      type: 'monthly_optimization',
      status: 'running',
    });

    if (existingRun) {
      return NextResponse.json(
        {
          error: 'Optimization already running',
          cronRunId: existingRun._id.toString(),
        },
        { status: 409 }
      );
    }

    // Create CronRun document
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

    // Get symbols (use provided or fetch top symbols)
    const topSymbols = symbols || (await getTopSymbols(5)) || FALLBACK_SYMBOLS;

    // Start background job (don't await)
    runMonthlyOptimization({
      cronRunId: cronRun._id,
      topSymbols,
      months,
      autoActivate,
    }).catch(async (error) => {
      console.error('Manual optimization error:', error);
      await CronRun.updateOne(
        { _id: cronRun._id },
        {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        }
      );
    });

    return NextResponse.json({
      message: 'Monthly optimization started',
      cronRunId: cronRun._id.toString(),
      config: {
        symbols: topSymbols,
        months,
        autoActivate,
      },
    });
  } catch (error) {
    console.error('Trigger optimization error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
