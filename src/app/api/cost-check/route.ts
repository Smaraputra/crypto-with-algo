import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { costCheckSymbols } from '@/lib/costs/market-facts';
import { pickMeasurementInterval } from '@/lib/costs/move';
import {
  buildMarketFacts,
  getExchangeSymbols,
  lastGoodKey,
  readLastGood,
  venueErrorResponse,
  writeLastGood,
} from '@/lib/cost-check-server';
import { createRateLimiter, rateLimitUser } from '@/lib/rate-limit';
import type { CostCheckError, CostCheckMarketResponse } from '@/types/cost-check';

const costCheckLimiter = createRateLimiter(20, 60);

const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;
const MAX_HOLD_MINUTES = 30 * 24 * 60;
const MAX_NOTIONAL = 10_000_000;
const DEFAULT_NOTIONAL = 1000;

function invalid(message: string): NextResponse<CostCheckError> {
  return NextResponse.json({ error: 'invalid_request', message }, { status: 400 });
}

/**
 * GET /api/cost-check?symbol=&holdMinutes=&notional=
 *
 * Market facts and the measured move for one perpetual and one hold length.
 * No cost arithmetic happens here: the client computes it from these facts.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limited = await rateLimitUser(`cost-check:${session.user.id}`, costCheckLimiter);
  if (limited) return limited;

  const params = req.nextUrl.searchParams;
  const symbol = params.get('symbol') ?? '';
  if (!SYMBOL_PATTERN.test(symbol)) {
    return invalid('symbol must look like BTCUSDT.');
  }

  const holdRaw = params.get('holdMinutes') ?? '';
  const holdMinutes = /^\d+$/.test(holdRaw) ? Number(holdRaw) : Number.NaN;
  if (!Number.isInteger(holdMinutes) || holdMinutes < 1 || holdMinutes > MAX_HOLD_MINUTES) {
    return invalid(`holdMinutes must be a whole number from 1 to ${MAX_HOLD_MINUTES}.`);
  }

  const notionalRaw = params.get('notional');
  const notional = notionalRaw === null || notionalRaw === '' ? DEFAULT_NOTIONAL : Number(notionalRaw);
  if (!Number.isFinite(notional) || notional <= 0 || notional > MAX_NOTIONAL) {
    return invalid(`notional must be greater than 0 and at most ${MAX_NOTIONAL}.`);
  }

  const measurement = pickMeasurementInterval(holdMinutes * 60_000);
  const key = lastGoodKey(symbol, measurement);

  try {
    const exchangeSymbols = await getExchangeSymbols();
    if (!costCheckSymbols(exchangeSymbols).some((s) => s.symbol === symbol)) {
      return NextResponse.json(
        { error: 'unknown_symbol', message: `${symbol} is not a tradable USDT-M perpetual.` },
        { status: 404 }
      );
    }

    const body = await buildMarketFacts(symbol, measurement, notional, exchangeSymbols, Date.now());
    await writeLastGood(key, body);
    return NextResponse.json(body);
  } catch (error) {
    const lastGood = await readLastGood(key);
    if (lastGood) {
      const stale: CostCheckMarketResponse = { ...lastGood, stale: true };
      return NextResponse.json(stale);
    }
    return venueErrorResponse(error);
  }
}
