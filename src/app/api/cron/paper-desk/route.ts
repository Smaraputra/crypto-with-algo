import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { connectDB } from '@/lib/mongodb';
import { runPaperDesk } from '@/lib/paper-desk/run';

/**
 * Steps every paper book forward over its newly closed bars.
 *
 * A pure consumer of `GlobalSignal`: it reads the live score, never writes one
 * and never scores, so `configVersion` stays untouched and the live record
 * keeps accumulating undisturbed.
 *
 * Runs every minute because the 1m book needs it. A book with nothing new to
 * step returns in a couple of queries, and each book takes a lease so an
 * overlapping run is a no-op rather than a double-step.
 */
async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();
  const report = await runPaperDesk();

  return NextResponse.json({
    opened: report.opened,
    closed: report.closed,
    leasedOut: report.leasedOut,
    errors: report.errors,
    books: report.books,
  });
}

export const GET = withJobRun('paper-desk', handler);
