import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { getVolatilityRegime, venueErrorResponse } from '@/lib/cost-check-server';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';

/**
 * GET /api/cost-check/regime
 *
 * BTCUSDT's realised volatility over the last complete UTC day, ranked against
 * the 180 days before it (`@/lib/costs/volatility-regime`). The same for every
 * symbol and user; cached per day.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  try {
    return NextResponse.json(await getVolatilityRegime(Date.now()));
  } catch (error) {
    return venueErrorResponse(error);
  }
}
