import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { runLabSignals8h, runLabSignalsFast } from '@/lib/signals/lab/job-signals';

/**
 * Live signal generator for the forward signal lab (lab-v1).
 *
 * The 8h cadence scores hypotheses L1, L3 and L4 at minute 3 after each 8h close
 * (00:03, 08:03, 16:03 UTC) and retries at minute 8 with attempt=retry (the final
 * attempt before the 10-minute bet window closes). The fast cadence scores L2
 * across fast timeframes every minute within each timeframe's delay window.
 * A stored lab signal is never rewritten. A job that fails answers 500 so its
 * heartbeat shows the failure.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const cadence = url.searchParams.get('cadence');
  const attempt = url.searchParams.get('attempt');

  if (cadence !== '8h' && cadence !== 'fast') {
    return NextResponse.json({ error: 'cadence must be 8h or fast' }, { status: 400 });
  }

  try {
    const result =
      cadence === '8h'
        ? await runLabSignals8h(Date.now(), undefined, { final: attempt === 'retry' })
        : await runLabSignalsFast(Date.now());
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('lab signal job failed:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = withJobRun((req) => {
  const url = new URL(req.url);
  const cadence = url.searchParams.get('cadence');
  const attempt = url.searchParams.get('attempt');
  if (cadence === 'fast') {
    return 'lab-signals:fast';
  }
  if (cadence === '8h') {
    return attempt === 'retry' ? 'lab-signals:8h:retry' : 'lab-signals:8h';
  }
  return 'lab-signals:invalid';
}, handler);
