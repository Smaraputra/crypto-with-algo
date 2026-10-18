import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { fetchKlines } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';
import { priorDayLevels, type PriorDayLevels } from '@/lib/market/levels';

export const dynamic = 'force-dynamic';

const SYMBOL_REGEX = /^[A-Z0-9]{2,20}USDT$/;

const querySchema = z.object({
  symbols: z
    .string()
    .min(1, 'symbols query parameter is required')
    .transform((val) => val.split(',').map((s) => s.trim()))
    .refine((items) => items.length >= 1 && items.length <= 20, {
      message: 'Must provide between 1 and 20 symbols',
    })
    .refine((items) => items.every((s) => SYMBOL_REGEX.test(s)), {
      message: 'Invalid symbol format',
    })
    .transform((items) => Array.from(new Set(items)))
    .refine((items) => items.length >= 1 && items.length <= 20, {
      message: 'Must provide between 1 and 20 unique symbols',
    }),
});

const limiter = createRateLimiter(30, 60);

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimit(req, limiter);
  if (limited) return limited;

  const rawSymbols = req.nextUrl.searchParams.get('symbols');
  const parsed = querySchema.safeParse({
    symbols: rawSymbols ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const symbols = parsed.data.symbols;
  const now = new Date();
  const nowMs = now.getTime();
  const asOf = now.toISOString();

  const results = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const candles = await cachedFetch(
        `levels:1d:${symbol}`,
        () => fetchKlines(symbol, '1d', 30),
        600
      );
      return priorDayLevels(candles, nowMs);
    })
  );

  const levels: Record<string, PriorDayLevels | null> = {};
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const res = results[i];
    levels[symbol] = res.status === 'fulfilled' ? res.value : null;
  }

  return NextResponse.json(
    { asOf, levels },
    {
      headers: {
        'Cache-Control': 'private, max-age=60',
      },
    }
  );
}
