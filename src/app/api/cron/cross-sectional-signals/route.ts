import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { generateAndSaveCrossSectionalSignal } from '@/lib/signals/cross-sectional/generator';

/**
 * 8-Hour Cross-Sectional Relative Value Signal Pipeline.
 * Evaluates the top 10 perpetual markets at 00:00, 08:00, and 16:00 UTC.
 */
async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const doc = await generateAndSaveCrossSectionalSignal();

    return NextResponse.json({
      success: true,
      timestamp: doc.timestamp,
      barCloseTime: doc.barCloseTime,
      rebalanced: doc.rebalanced,
      turnover: doc.turnover,
      netBetaExposure: doc.netBetaExposure,
      targets: doc.targets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error generating cross-sectional signals:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = withJobRun('cross-sectional-signals', handler);
