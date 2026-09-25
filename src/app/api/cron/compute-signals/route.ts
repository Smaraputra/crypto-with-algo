import { NextRequest, NextResponse } from 'next/server';

import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import type { TradingStyle } from '@/lib/models/signal-template';
import { connectDB } from '@/lib/mongodb';
import { computeSignalBatch, buildTasksForStyle } from '@/lib/signals/compute-engine';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';

function isValidTradingStyle(style: string): style is TradingStyle {
  return (TRADING_STYLES as readonly string[]).includes(style);
}

/**
 * New global signal computation for a specific trading style.
 * Uses the compute engine to batch-process all configured symbols.
 */
async function computeGlobalSignals(style: TradingStyle) {
  const tasks = buildTasksForStyle(style, [...SIGNAL_SYMBOLS]);
  const result = await computeSignalBatch(tasks);

  return NextResponse.json({
    mode: 'global',
    style,
    computed: result.computed,
    errors: result.errors,
    skipped: result.skipped,
    tasks: tasks.length,
  });
}

async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  // `style` is required. It used to be optional, and omitting it ran a third
  // scorer: `computeLegacySignals()` scored each user's own Strategy rows with
  // DEFAULT_CONFIG periods, DEFAULT_WEIGHTS, no HTF, no news and no
  // configVersion, on its own `*/10` cron. Its only reader was the journal's
  // indicator snapshot, which now computes its own; nothing reads the `Signal`
  // collection any more.
  const styleParam = req.nextUrl.searchParams.get('style');
  if (!styleParam) {
    return NextResponse.json({ error: 'Missing trading style' }, { status: 400 });
  }
  if (!isValidTradingStyle(styleParam)) {
    return NextResponse.json(
      { error: `Invalid trading style: ${styleParam}` },
      { status: 400 }
    );
  }

  return computeGlobalSignals(styleParam);
}

// The handler body is unchanged; the wrapper only records that the run
// happened and what it returned. A 401 writes nothing.
export const GET = withJobRun((req) => `compute-signals:${new URL(req.url).searchParams.get('style') ?? 'missing-style'}`, handler);
