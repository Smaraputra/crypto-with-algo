import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { withJobRun } from '@/lib/job-run';
import { runLabSignals8h, runLabSignalsFast } from '@/lib/signals/lab/job-signals';
import { runLabV2Daily, runLabV2Weekly } from '@/lib/signals/lab/job-signals-v2';
import { runLabV3Daily } from '@/lib/signals/lab/job-signals-v3';
import { runLabV4Hourly } from '@/lib/signals/lab/job-signals-v4';

/**
 * Live signal generator for the forward signal lab (lab-v1, lab-v2, lab-v3 and lab-v4).
 *
 * The 8h cadence scores hypotheses L1, L3 and L4 at minute 3 after each 8h close
 * (00:03, 08:03, 16:03 UTC) and retries at minute 8 with attempt=retry (the final
 * attempt before the 10-minute bet window closes). The fast cadence scores L2
 * across fast timeframes every minute within each timeframe's delay window.
 * The v2-1w cadence scores N2 at Monday 00:03 UTC (retry 00:08 UTC).
 * The v2-1d cadence scores N3 at 00:03 UTC (retry 00:08 UTC).
 * The v3-1d cadence scores F1 at 00:04 UTC (retry 00:09 UTC).
 * The v4-1h cadence scores S1 and S2 hourly at minute 3 (retry at minute 8).
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

  if (
    cadence !== '8h' &&
    cadence !== 'fast' &&
    cadence !== 'v2-1w' &&
    cadence !== 'v2-1d' &&
    cadence !== 'v3-1d' &&
    cadence !== 'v4-1h'
  ) {
    return NextResponse.json({ error: 'cadence must be 8h, fast, v2-1w, v2-1d, v3-1d or v4-1h' }, { status: 400 });
  }

  try {
    const isRetry = attempt === 'retry';
    const now = Date.now();
    const result =
      cadence === '8h'
        ? await runLabSignals8h(now, undefined, { final: isRetry })
        : cadence === 'fast'
        ? await runLabSignalsFast(now)
        : cadence === 'v2-1w'
        ? await runLabV2Weekly(now, undefined, { final: isRetry })
        : cadence === 'v2-1d'
        ? await runLabV2Daily(now, undefined, { final: isRetry })
        : cadence === 'v3-1d'
        ? await runLabV3Daily(now, undefined, { final: isRetry })
        : await runLabV4Hourly(now, undefined, { final: isRetry });
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
  if (cadence === 'v2-1w') {
    return attempt === 'retry' ? 'lab-v2-signals:1w:retry' : 'lab-v2-signals:1w';
  }
  if (cadence === 'v2-1d') {
    return attempt === 'retry' ? 'lab-v2-signals:1d:retry' : 'lab-v2-signals:1d';
  }
  if (cadence === 'v3-1d') {
    return attempt === 'retry' ? 'lab-v3-signals:1d:retry' : 'lab-v3-signals:1d';
  }
  if (cadence === 'v4-1h') {
    return attempt === 'retry' ? 'lab-v4-signals:1h:retry' : 'lab-v4-signals:1h';
  }
  return 'lab-signals:invalid';
}, handler);
