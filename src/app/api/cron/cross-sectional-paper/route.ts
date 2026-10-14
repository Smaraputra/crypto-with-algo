import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { runRvDesk } from '@/lib/paper-desk/rv-desk';

/**
 * Steps the rv-v1 paper book over every stored signal whose first fill hour
 * has closed (01:05, 09:05 and 17:05 UTC). A step that cannot be taken stays
 * pending with its reason; once one has been pending for a full cadence the
 * route answers 500, so the heartbeat shows the stalled book.
 */
async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await runRvDesk(Date.now(), randomUUID());
    if (report.leased && report.stalePending) {
      const reasons = report.pending.flatMap((p) => p.reasons).join(', ');
      return NextResponse.json(
        { success: false, error: `rv-v1 step pending for more than one cadence: ${reasons}`, ...report },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true, ...report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('rv-v1 paper desk failed:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = withJobRun('cross-sectional-paper', handler);
