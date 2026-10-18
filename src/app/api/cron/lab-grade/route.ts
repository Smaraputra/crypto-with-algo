import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { runLabGrade } from '@/lib/signals/lab/job-grade';

/**
 * Forward signal lab grading job (lab-v1).
 *
 * Grades due bars in bar-close order once their return window has closed.
 * Graded score rows are permanent and write-once. A job that fails answers
 * 500 so its heartbeat shows the failure.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runLabGrade(Date.now());
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('lab grade job failed:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = withJobRun('lab-grade', handler);
