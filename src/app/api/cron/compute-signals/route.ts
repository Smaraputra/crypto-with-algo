import { NextRequest, NextResponse } from 'next/server';

import { fetchKlines } from '@/lib/binance';
import { getCandles } from '@/lib/candle-ingestion';
import { fetchFundingRate, fetchLongShortRatio } from '@/lib/binance-futures';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { interpretIndicators } from '@/lib/indicators/interpret';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { RECOMMENDED_CANDLES } from '@/lib/indicators/types';
import { Signal } from '@/lib/models/signal';
import { Strategy } from '@/lib/models/strategy';
import { connectDB } from '@/lib/mongodb';
import { cachedFetch } from '@/lib/redis';
import { computeSignalScore } from '@/lib/signals/scorer';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';
import type { FuturesData } from '@/types/futures';
import type { SentimentData } from '@/types/signal';

const MAX_PAIRS_PER_RUN = 20;

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

async function fetchFuturesDataSafe(symbol: string): Promise<FuturesData> {
  const result: FuturesData = {
    fundingRate: null,
    openInterest: null,
    longShortRatio: null,
  };

  try {
    const rates = await cachedFetch(
      `futures:funding:${symbol}:1`,
      () => fetchFundingRate(symbol, 1),
      300
    );
    if (rates.length > 0) result.fundingRate = rates[0];
  } catch {
    // Futures data is optional
  }

  try {
    const ratios = await cachedFetch(
      `futures:ls:top:${symbol}:1h:1`,
      () => fetchLongShortRatio(symbol, '1h', 1),
      300
    );
    if (ratios.length > 0) result.longShortRatio = ratios[0];
  } catch {
    // Futures data is optional
  }

  return result;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  // Find all active strategies
  const strategies = await Strategy.find({ active: true });
  if (strategies.length === 0) {
    return NextResponse.json({ computed: 0, errors: 0 });
  }

  // Deduplicate (symbol, interval) pairs across all strategies
  const pairsSet = new Set<string>();
  const userPairsMap = new Map<string, Array<{ userId: string; weights: typeof strategies[0]['weights'] }>>();

  for (const strategy of strategies) {
    for (const symbol of strategy.symbols) {
      for (const interval of strategy.intervals) {
        const key = `${symbol}:${interval}`;
        pairsSet.add(key);

        if (!userPairsMap.has(key)) {
          userPairsMap.set(key, []);
        }
        userPairsMap.get(key)!.push({
          userId: strategy.userId,
          weights: strategy.weights,
        });
      }
    }
  }

  // Limit to MAX_PAIRS_PER_RUN
  const pairs = [...pairsSet].slice(0, MAX_PAIRS_PER_RUN);

  // Fetch sentiment once for all pairs (cached 5min)
  const sentimentData: SentimentData | null = await fetchFearAndGreed().catch(() => null);

  let computed = 0;
  let errors = 0;

  for (const pair of pairs) {
    const [symbol, interval] = pair.split(':');

    try {
      const [candles, futuresData] = await Promise.all([
        cachedFetch(
          `klines:${symbol}:${interval}:${RECOMMENDED_CANDLES}`,
          async () => {
            const dbCandles = await getCandles(
              symbol,
              interval,
              undefined,
              undefined,
              RECOMMENDED_CANDLES
            );
            if (dbCandles.length >= RECOMMENDED_CANDLES) return dbCandles;
            return fetchKlines(symbol, interval, RECOMMENDED_CANDLES);
          },
          60
        ),
        fetchFuturesDataSafe(symbol),
      ]);

      const raw = computeAllIndicators(candles, symbol, interval);
      const indicators = interpretIndicators(raw);
      const superTrend = computeSuperTrend(candles);

      // Create a signal for each user who has this pair in their strategy
      const users = userPairsMap.get(pair) || [];
      for (const { userId, weights } of users) {
        const signal = computeSignalScore(
          indicators,
          futuresData,
          sentimentData,
          weights,
          superTrend
        );

        await Signal.create({
          userId,
          symbol: signal.symbol,
          interval: signal.interval,
          score: signal.score,
          tier: signal.tier,
          confidence: signal.confidence,
          components: signal.components,
        });

        computed++;
      }
    } catch {
      errors++;
    }
  }

  return NextResponse.json({ computed, errors, pairs: pairs.length });
}
