import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { runRvSignal } from '@/lib/signals/cross-sectional/generator';

/**
 * Scores the 8h bar that just closed with the rv-v1 engine (00:01, 08:01 and
 * 16:01 UTC) and stores it once. The `attempt=retry` line at minute 31 runs
 * the same job: a stored signal is never rewritten, so it only fills a bar the
 * first attempt could not store. A job that could not score the bar answers
 * 500, so its heartbeat shows the failure.
 */
async function handler(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runRvSignal(Date.now());
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('rv-v1 signal job failed:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = withJobRun((req) => {
  const attempt = new URL(req.url).searchParams.get('attempt');
  return attempt ? `cross-sectional-signals:${attempt}` : 'cross-sectional-signals';
}, handler);
