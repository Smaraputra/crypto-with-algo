import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { Alert, type IAlert } from '@/lib/models/alert';
import { Portfolio } from '@/lib/models/portfolio';
import { fetchTickerPrices } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

function isWithinCooldown(alert: IAlert): boolean {
  if (!alert.lastTriggeredAt) return false;
  const cooldownMs = alert.cooldownMinutes * 60 * 1000;
  return Date.now() - new Date(alert.lastTriggeredAt).getTime() < cooldownMs;
}

async function getPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  const cacheKey = `cron:prices:${symbols.sort().join(',')}`;
  return cachedFetch(cacheKey, () => fetchTickerPrices(symbols), 30);
}

async function evaluatePriceAlerts(
  alerts: IAlert[],
  prices: Record<string, number>
): Promise<IAlert[]> {
  const triggered: IAlert[] = [];
  const now = new Date();

  for (const alert of alerts) {
    const price = prices[alert.symbol];
    if (price === undefined) continue;

    let shouldTrigger = false;

    switch (alert.type) {
      case 'price_above':
        shouldTrigger = alert.targetPrice !== null && price >= alert.targetPrice;
        break;
      case 'price_below':
        shouldTrigger = alert.targetPrice !== null && price <= alert.targetPrice;
        break;
      case 'price_change_pct':
        if (alert.referencePrice !== null && alert.percentChange !== null) {
          const pctChange =
            ((price - alert.referencePrice) / alert.referencePrice) * 100;
          shouldTrigger = Math.abs(pctChange) >= Math.abs(alert.percentChange);
        }
        break;
    }

    if (!shouldTrigger) continue;
    if (alert.recurring && isWithinCooldown(alert)) continue;

    if (alert.recurring) {
      await Alert.updateOne(
        { _id: alert._id },
        { lastTriggeredAt: now, triggeredAt: now }
      );
    } else {
      await Alert.updateOne(
        { _id: alert._id },
        { status: 'triggered', triggeredAt: now }
      );
    }
    triggered.push(alert);
  }

  return triggered;
}

async function evaluatePortfolioAlerts(
  alerts: IAlert[],
  prices: Record<string, number>
): Promise<IAlert[]> {
  const triggered: IAlert[] = [];
  const now = new Date();

  const portfolioIds = [...new Set(alerts.map((a) => a.portfolioId).filter(Boolean))];
  const portfolios = await Portfolio.find({ _id: { $in: portfolioIds } });
  const portfolioMap = new Map(portfolios.map((p) => [p._id.toString(), p]));

  for (const alert of alerts) {
    const portfolio = portfolioMap.get(alert.portfolioId ?? '');
    if (!portfolio) continue;

    let totalValue = 0;
    for (const holding of portfolio.holdings) {
      const holdingPrice = prices[holding.symbol];
      if (holdingPrice !== undefined) {
        totalValue += holding.quantity * holdingPrice;
      }
    }

    let shouldTrigger = false;

    if (
      alert.type === 'portfolio_value_above' &&
      alert.targetPrice !== null
    ) {
      shouldTrigger = totalValue >= alert.targetPrice;
    } else if (
      alert.type === 'portfolio_value_below' &&
      alert.targetPrice !== null
    ) {
      shouldTrigger = totalValue <= alert.targetPrice;
    }

    if (!shouldTrigger) continue;
    if (alert.recurring && isWithinCooldown(alert)) continue;

    if (alert.recurring) {
      await Alert.updateOne(
        { _id: alert._id },
        { lastTriggeredAt: now, triggeredAt: now }
      );
    } else {
      await Alert.updateOne(
        { _id: alert._id },
        { status: 'triggered', triggeredAt: now }
      );
    }
    triggered.push(alert);
  }

  return triggered;
}

async function evaluateHoldingAlerts(
  alerts: IAlert[],
  prices: Record<string, number>
): Promise<IAlert[]> {
  const triggered: IAlert[] = [];
  const now = new Date();

  const portfolioIds = [...new Set(alerts.map((a) => a.portfolioId).filter(Boolean))];
  const portfolios = await Portfolio.find({ _id: { $in: portfolioIds } });
  const portfolioMap = new Map(portfolios.map((p) => [p._id.toString(), p]));

  for (const alert of alerts) {
    const portfolio = portfolioMap.get(alert.portfolioId ?? '');
    if (!portfolio) continue;

    const holding = portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === alert.symbol
    );
    if (!holding || holding.avgBuyPrice === 0) continue;

    const currentPrice = prices[alert.symbol];
    if (currentPrice === undefined) continue;

    const pctChange =
      ((currentPrice - holding.avgBuyPrice) / holding.avgBuyPrice) * 100;

    if (alert.percentChange === null) continue;
    const shouldTrigger = Math.abs(pctChange) >= Math.abs(alert.percentChange);

    if (!shouldTrigger) continue;
    if (alert.recurring && isWithinCooldown(alert)) continue;

    if (alert.recurring) {
      await Alert.updateOne(
        { _id: alert._id },
        { lastTriggeredAt: now, triggeredAt: now }
      );
    } else {
      await Alert.updateOne(
        { _id: alert._id },
        { status: 'triggered', triggeredAt: now }
      );
    }
    triggered.push(alert);
  }

  return triggered;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();
  const activeAlerts: IAlert[] = await Alert.find({ status: 'active' });

  if (activeAlerts.length === 0) {
    return NextResponse.json({ evaluated: 0, triggered: 0 });
  }

  const priceAlerts = activeAlerts.filter((a) =>
    ['price_above', 'price_below', 'price_change_pct'].includes(a.type)
  );
  const portfolioAlerts = activeAlerts.filter((a) =>
    ['portfolio_value_above', 'portfolio_value_below'].includes(a.type)
  );
  const holdingAlerts = activeAlerts.filter((a) => a.type === 'holding_change_pct');

  // Collect all needed symbols
  const allSymbols = new Set<string>();
  for (const a of priceAlerts) {
    if (a.symbol) allSymbols.add(a.symbol);
  }
  // For portfolio/holding alerts, we need to fetch portfolio holdings' symbols
  const portfolioIds = [
    ...new Set(
      [...portfolioAlerts, ...holdingAlerts]
        .map((a) => a.portfolioId)
        .filter(Boolean)
    ),
  ];

  let portfolioSymbols: string[] = [];
  if (portfolioIds.length > 0) {
    const portfolios = await Portfolio.find({ _id: { $in: portfolioIds } });
    for (const p of portfolios) {
      for (const h of p.holdings) {
        allSymbols.add(h.symbol);
      }
    }
    portfolioSymbols = portfolios.flatMap((p) =>
      p.holdings.map((h: { symbol: string }) => h.symbol)
    );
  }
  // Also add holding alert symbols
  for (const a of holdingAlerts) {
    if (a.symbol) allSymbols.add(a.symbol);
  }

  void portfolioSymbols; // collected via allSymbols

  const prices = await getPrices([...allSymbols]);

  const allTriggered: IAlert[] = [];

  if (priceAlerts.length > 0) {
    const t = await evaluatePriceAlerts(priceAlerts, prices);
    allTriggered.push(...t);
  }

  if (portfolioAlerts.length > 0) {
    const t = await evaluatePortfolioAlerts(portfolioAlerts, prices);
    allTriggered.push(...t);
  }

  if (holdingAlerts.length > 0) {
    const t = await evaluateHoldingAlerts(holdingAlerts, prices);
    allTriggered.push(...t);
  }

  return NextResponse.json({
    evaluated: activeAlerts.length,
    triggered: allTriggered.length,
  });
}
