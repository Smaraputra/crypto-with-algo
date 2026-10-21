import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { cachedFetch } from '@/lib/redis';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';
import { fetchPerpKlinesOhlcv } from '@/lib/binance-futures';
import {
  MTF_INTERVALS,
  mtfState,
  type MtfInterval,
  type MtfState,
} from '@/lib/market/mtf';
import { priorDayLevels, type PriorDayLevels } from '@/lib/market/levels';
import type { OHLCV } from '@/types/market';

export const dynamic = 'force-dynamic';

const SYMBOL_REGEX = /^[A-Z0-9]{2,20}USDT$/;

const MTF_TTLS: Record<MtfInterval, number> = {
  '15m': 60,
  '1h': 120,
  '4h': 300,
  '1d': 600,
};

const limiter = createRateLimiter(30, 60);

export interface MtfIntervalError {
  interval: MtfInterval;
  error: true;
}

export type FocusMtfRow = MtfState | MtfIntervalError;

export interface FocusMtfResponse {
  symbol: string;
  states: FocusMtfRow[];
  priorDay: PriorDayLevels | null;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimit(req, limiter);
  if (limited) return limited;

  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol || !SYMBOL_REGEX.test(symbol)) {
    return NextResponse.json(
      { error: 'Invalid or missing symbol parameter' },
      { status: 400 }
    );
  }

  const nowMs = Date.now();
  const states: FocusMtfRow[] = [];
  let dailyCandles: OHLCV[] | null = null;

  for (const interval of MTF_INTERVALS) {
    try {
      const candles = await cachedFetch(
        `focus:perp-klines:${symbol}:${interval}:200`,
        () => fetchPerpKlinesOhlcv(symbol, interval, 200),
        MTF_TTLS[interval]
      );
      if (interval === '1d') {
        dailyCandles = candles;
      }
      states.push(mtfState(interval, candles, nowMs));
    } catch {
      states.push({ interval, error: true });
    }
  }

  const priorDay = dailyCandles ? priorDayLevels(dailyCandles, nowMs) : null;

  return NextResponse.json(
    {
      symbol,
      states,
      priorDay,
    },
    {
      headers: {
        'Cache-Control': 'private, max-age=30',
      },
    }
  );
}
