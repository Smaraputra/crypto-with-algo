import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { costCheckSymbols } from '@/lib/costs/market-facts';
import { EXCHANGE_INFO_TTL, getExchangeSymbols, venueErrorResponse } from '@/lib/cost-check-server';
import { cachedFetch } from '@/lib/redis';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';
import type { CostCheckSymbolsResponse } from '@/types/cost-check';

/**
 * GET /api/cost-check/symbols
 *
 * Every crypto USDT-M perpetual that is trading, for the cost check's symbol
 * picker. Cached for an hour.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  try {
    const body = await cachedFetch<CostCheckSymbolsResponse>(
      'cost-check:symbols',
      async () => ({
        symbols: costCheckSymbols(await getExchangeSymbols()),
        asOf: Date.now(),
        stale: false,
      }),
      EXCHANGE_INFO_TTL
    );
    return NextResponse.json(body);
  } catch (error) {
    return venueErrorResponse(error);
  }
}
