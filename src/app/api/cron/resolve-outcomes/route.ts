import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { connectDB } from '@/lib/mongodb';
import { resolveDueOutcomes } from '@/lib/signals/outcome-resolver';

async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const counts = await resolveDueOutcomes();

  return NextResponse.json(counts);
}

// The handler body is unchanged; the wrapper only records that the run
// happened and what it returned. A 401 writes nothing.
export const GET = withJobRun('resolve-outcomes', handler);
