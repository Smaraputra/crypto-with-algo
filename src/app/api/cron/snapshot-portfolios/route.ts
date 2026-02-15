import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { Portfolio, type IPortfolio } from '@/lib/models/portfolio';
import {
  PortfolioSnapshot,
  truncateToMidnightUTC,
} from '@/lib/models/portfolio-snapshot';
import { fetchTickerPrices } from '@/lib/binance';
import { cachedFetch, redis } from '@/lib/redis';

import { verifyCronSecret } from '@/lib/cron-auth';

async function getPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  const cacheKey = `cron:snapshot-prices:${symbols.sort().join(',')}`;
  return cachedFetch(cacheKey, () => fetchTickerPrices(symbols), 30);
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = truncateToMidnightUTC(new Date());
  const dedupKey = `snapshot:${today.toISOString().slice(0, 10)}`;

  if (redis) {
    try {
      const already = await redis.get(dedupKey);
      if (already) {
        return NextResponse.json({ skipped: true, reason: 'already-run-today' });
      }
    } catch {
      // Redis unavailable, proceed
    }
  }

  await connectDB();

  const portfolios: IPortfolio[] = await Portfolio.find({
    'holdings.0': { $exists: true },
  });

  if (portfolios.length === 0) {
    return NextResponse.json({ snapshots: 0, portfolios: 0 });
  }

  const allSymbols = new Set<string>();
  for (const p of portfolios) {
    for (const h of p.holdings) {
      if (h.quantity > 0) allSymbols.add(h.symbol);
    }
  }

  const prices = await getPrices([...allSymbols]);

  let snapshotCount = 0;

  for (const portfolio of portfolios) {
    try {
      const holdings = [];
      let totalValue = 0;
      let totalCost = 0;

      for (const h of portfolio.holdings) {
        if (h.quantity <= 0) continue;
        const price = prices[h.symbol];
        if (price === undefined) continue;

        const value = h.quantity * price;
        totalValue += value;
        totalCost += h.avgBuyPrice * h.quantity;

        holdings.push({
          symbol: h.symbol,
          quantity: h.quantity,
          price,
          value,
        });
      }

      if (holdings.length === 0) continue;

      const unrealizedPnl = totalValue - totalCost;
      const unrealizedPnlPercent =
        totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;

      await PortfolioSnapshot.findOneAndUpdate(
        { portfolioId: portfolio._id.toString(), date: today },
        {
          userId: portfolio.userId,
          portfolioId: portfolio._id.toString(),
          date: today,
          totalValue,
          totalCost,
          unrealizedPnl,
          unrealizedPnlPercent,
          holdings,
        },
        { upsert: true, new: true }
      );

      snapshotCount++;
    } catch (err) {
      console.error(
        `Failed to snapshot portfolio ${portfolio._id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (redis) {
    try {
      await redis.set(dedupKey, '1', { ex: 86400 });
    } catch {
      // Redis set failed
    }
  }

  return NextResponse.json({ snapshots: snapshotCount, portfolios: portfolios.length });
}
