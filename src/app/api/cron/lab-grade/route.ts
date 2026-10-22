import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { type LabGradeReport, runLabGrade } from '@/lib/signals/lab/job-grade';
import { runLabGradeV4 } from '@/lib/signals/lab/job-grade-v4';

/**
 * Forward signal lab grading job (lab-v1 to v4).
 *
 * Grades due bars in bar-close order once their return window has closed.
 * Runs lab-v1 to v3 first, followed by a separate pass for lab-v4.
 * Graded score rows are permanent and write-once. A job that fails answers
 * 500 so its heartbeat shows the failure.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let r1: LabGradeReport = {
    success: false,
    graded: [],
    pending: [],
    errors: [],
  };
  try {
    r1 = await runLabGrade(Date.now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('lab-v1..v3 grade job failed:', error);
    r1.errors.push(message);
    r1.success = false;
  }

  let r2: LabGradeReport = {
    success: false,
    graded: [],
    pending: [],
    errors: [],
  };
  try {
    r2 = await runLabGradeV4(Date.now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('lab-v4 grade job failed:', error);
    r2.errors.push(message);
    r2.success = false;
  }

  const merged: LabGradeReport = {
    success: r1.success && r2.success,
    graded: [...r1.graded, ...r2.graded],
    pending: [...r1.pending, ...r2.pending],
    errors: [...r1.errors, ...r2.errors],
  };

  return NextResponse.json(merged, { status: merged.success ? 200 : 500 });
}

export const GET = withJobRun('lab-grade', handler);
