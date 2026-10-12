import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { runCrossSectionalPaperDesk } from '@/lib/paper-desk/cross-sectional-runner';

/**
 * 8-Hour Cross-Sectional Relative Value Paper Trading Desk.
 * Rebalances the paper portfolio following each newly generated 8h signal.
 */
async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await runCrossSectionalPaperDesk();

    return NextResponse.json({
      success: true,
      stepped: report.stepped,
      closedTradesCount: report.closedTradesCount,
      openPositionsCount: report.openPositionsCount,
      equityMaker: report.equityMaker,
      equityTaker: report.equityTaker,
      markedEquityMaker: report.markedEquityMaker ?? report.equityMaker,
      markedEquityTaker: report.markedEquityTaker ?? report.equityTaker,
      leasedOut: report.leasedOut ?? false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error running cross-sectional paper desk:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = withJobRun('cross-sectional-paper', handler);
