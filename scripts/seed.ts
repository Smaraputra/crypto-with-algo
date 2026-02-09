/**
 * Data seeder -- populates a demo account with realistic portfolio data.
 *
 * Usage:
 *   npm run seed
 *   SEED_EMAIL=custom@example.com npm run seed
 *
 * Requires MONGODB_URI in .env.local (or environment).
 * Optionally uses BINANCE_API_URL for real market data.
 * Falls back to hardcoded prices if Binance API is unreachable.
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/mongodb';
import { fetchKlines, fetchTickerPrices } from '@/lib/binance';
import { User } from '@/lib/models/user';
import { Portfolio } from '@/lib/models/portfolio';
import { Watchlist } from '@/lib/models/watchlist';
import { Alert } from '@/lib/models/alert';
import {
  PortfolioSnapshot,
  truncateToMidnightUTC,
} from '@/lib/models/portfolio-snapshot';

// Load .env.local if running outside Next.js
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env.local');
  try {
    const contents = readFileSync(envPath, 'utf-8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env.local not found, rely on environment variables
  }
}

// -- Configuration --

const DEMO_EMAIL = process.env.SEED_EMAIL || 'demo@cryptotracker.dev';
const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'DemoPassword123!';
const DEMO_NAME = 'Demo User';

interface HoldingConfig {
  symbol: string;
  baseAsset: string;
  quantity: number;
}

const HOLDINGS: HoldingConfig[] = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quantity: 0.5 },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quantity: 5.0 },
  { symbol: 'SOLUSDT', baseAsset: 'SOL', quantity: 50 },
  { symbol: 'BNBUSDT', baseAsset: 'BNB', quantity: 10 },
  { symbol: 'XRPUSDT', baseAsset: 'XRP', quantity: 5000 },
];

const WATCHLIST_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOTUSDT',
  'AVAXUSDT',
];

// Hardcoded fallback prices (used when Binance API is unreachable)
const FALLBACK_PRICES: Record<string, number> = {
  BTCUSDT: 67000,
  ETHUSDT: 3500,
  SOLUSDT: 140,
  BNBUSDT: 600,
  XRPUSDT: 0.55,
  ADAUSDT: 0.45,
  DOTUSDT: 7.5,
  AVAXUSDT: 35,
};

// -- Data fetching --

export interface DailyPrices {
  [symbol: string]: { date: Date; close: number }[];
}

export async function fetchRealData(): Promise<{
  currentPrices: Record<string, number>;
  dailyPrices: DailyPrices;
}> {
  const symbols = HOLDINGS.map((h) => h.symbol);
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  try {
    const currentPrices = await fetchTickerPrices(symbols);

    const dailyPrices: DailyPrices = {};
    for (const sym of symbols) {
      const klines = await fetchKlines(sym, '1d', 30, thirtyDaysAgo, now);
      dailyPrices[sym] = klines.map((k) => ({
        date: new Date(k.timestamp),
        close: k.close,
      }));
    }

    console.log('  Fetched real market data from Binance');
    return { currentPrices, dailyPrices };
  } catch (err) {
    console.log(
      `  Binance API unavailable (${err instanceof Error ? err.message : 'unknown error'}), using fallback prices`
    );
    return generateFallbackData();
  }
}

export function generateFallbackData(): {
  currentPrices: Record<string, number>;
  dailyPrices: DailyPrices;
} {
  const currentPrices: Record<string, number> = {};
  const dailyPrices: DailyPrices = {};
  const now = Date.now();

  for (const h of HOLDINGS) {
    const basePrice = FALLBACK_PRICES[h.symbol] ?? 100;
    currentPrices[h.symbol] = basePrice;
    dailyPrices[h.symbol] = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now - i * 24 * 60 * 60 * 1000);
      // Simulate slight daily variation (-3% to +3%)
      const variation = 1 + (Math.sin(i * 0.5) * 0.03);
      dailyPrices[h.symbol].push({
        date,
        close: +(basePrice * variation).toFixed(6),
      });
    }
  }

  return { currentPrices, dailyPrices };
}

// -- Seeding logic --

export function buildHoldings(
  dailyPrices: DailyPrices
): Array<{
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  quantity: number;
  avgBuyPrice: number;
  transactions: Array<{
    type: 'buy';
    quantity: number;
    price: number;
    date: Date;
    notes: string;
    fee: number;
  }>;
}> {
  return HOLDINGS.map((h) => {
    const prices = dailyPrices[h.symbol] ?? [];
    // Create 2-3 buy transactions at different historical prices
    const txDays = [25, 15, 5]; // days ago
    const portions = [0.5, 0.3, 0.2];
    const transactions = txDays.map((daysAgo, i) => {
      const priceEntry = prices.find(
        (p) => {
          const daysDiff = Math.abs(
            (Date.now() - p.date.getTime()) / (24 * 60 * 60 * 1000) - daysAgo
          );
          return daysDiff < 1.5;
        }
      );
      const price = priceEntry?.close ?? (FALLBACK_PRICES[h.symbol] ?? 100);
      const qty = +(h.quantity * portions[i]).toFixed(8);
      return {
        type: 'buy' as const,
        quantity: qty,
        price,
        date: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        notes: `Seed transaction ${i + 1}`,
        fee: 0,
      };
    });

    const totalQty = transactions.reduce((s, t) => s + t.quantity, 0);
    const totalCost = transactions.reduce(
      (s, t) => s + t.quantity * t.price,
      0
    );
    const avgBuyPrice = totalCost / totalQty;

    return {
      symbol: h.symbol,
      baseAsset: h.baseAsset,
      quoteAsset: 'USDT',
      quantity: totalQty,
      avgBuyPrice: +avgBuyPrice.toFixed(6),
      transactions,
    };
  });
}

export function buildAlerts(
  currentPrices: Record<string, number>,
  portfolioId: string
): Array<{
  symbol: string;
  portfolioId: string | null;
  type: string;
  targetPrice: number | null;
  percentChange: number | null;
  referencePrice: number | null;
  status: string;
  recurring: boolean;
  cooldownMinutes: number;
  message: string;
  triggeredAt: Date | null;
  notifiedAt: Date | null;
  lastTriggeredAt: Date | null;
}> {
  const btcPrice = currentPrices['BTCUSDT'] ?? 67000;
  const ethPrice = currentPrices['ETHUSDT'] ?? 3500;
  const solPrice = currentPrices['SOLUSDT'] ?? 140;

  return [
    {
      symbol: 'BTCUSDT',
      portfolioId: null,
      type: 'price_above',
      targetPrice: +(btcPrice * 1.05).toFixed(2),
      percentChange: null,
      referencePrice: null,
      status: 'active',
      recurring: false,
      cooldownMinutes: 60,
      message: 'BTC price target reached',
      triggeredAt: null,
      notifiedAt: null,
      lastTriggeredAt: null,
    },
    {
      symbol: 'ETHUSDT',
      portfolioId: null,
      type: 'price_below',
      targetPrice: +(ethPrice * 0.9).toFixed(2),
      percentChange: null,
      referencePrice: null,
      status: 'active',
      recurring: false,
      cooldownMinutes: 60,
      message: 'ETH price dropped below target',
      triggeredAt: null,
      notifiedAt: null,
      lastTriggeredAt: null,
    },
    {
      symbol: 'SOLUSDT',
      portfolioId: null,
      type: 'price_above',
      targetPrice: +(solPrice - 1).toFixed(2),
      percentChange: null,
      referencePrice: null,
      status: 'triggered',
      recurring: false,
      cooldownMinutes: 60,
      message: 'SOL price target reached',
      triggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      notifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lastTriggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    },
    {
      symbol: '',
      portfolioId,
      type: 'portfolio_value_above',
      targetPrice: 100000,
      percentChange: null,
      referencePrice: null,
      status: 'active',
      recurring: true,
      cooldownMinutes: 240,
      message: 'Portfolio value exceeds $100k',
      triggeredAt: null,
      notifiedAt: null,
      lastTriggeredAt: null,
    },
  ];
}

export function buildSnapshots(
  holdings: Array<{ symbol: string; quantity: number; avgBuyPrice: number }>,
  dailyPrices: DailyPrices,
  portfolioId: string
): Array<{
  portfolioId: string;
  date: Date;
  totalValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  holdings: Array<{
    symbol: string;
    quantity: number;
    price: number;
    value: number;
  }>;
}> {
  const totalCost = holdings.reduce(
    (s, h) => s + h.quantity * h.avgBuyPrice,
    0
  );

  // Build a set of all dates from daily prices
  const allDates: Date[] = [];
  const firstSymbol = Object.keys(dailyPrices)[0];
  if (firstSymbol) {
    for (const entry of dailyPrices[firstSymbol]) {
      allDates.push(truncateToMidnightUTC(entry.date));
    }
  }

  return allDates.map((date) => {
    const snapshotHoldings = holdings.map((h) => {
      const prices = dailyPrices[h.symbol] ?? [];
      const dayEntry = prices.find(
        (p) =>
          truncateToMidnightUTC(p.date).getTime() === date.getTime()
      );
      const price = dayEntry?.close ?? FALLBACK_PRICES[h.symbol] ?? 100;
      return {
        symbol: h.symbol,
        quantity: h.quantity,
        price,
        value: +(h.quantity * price).toFixed(2),
      };
    });

    const totalValue = snapshotHoldings.reduce((s, h) => s + h.value, 0);
    const unrealizedPnl = totalValue - totalCost;
    const unrealizedPnlPercent =
      totalCost > 0 ? +((unrealizedPnl / totalCost) * 100).toFixed(2) : 0;

    return {
      portfolioId,
      date,
      totalValue: +totalValue.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      unrealizedPnl: +unrealizedPnl.toFixed(2),
      unrealizedPnlPercent,
      holdings: snapshotHoldings,
    };
  });
}

// -- Main --

async function main() {
  loadEnv();

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Add it to .env.local or environment.');
    process.exit(1);
  }

  console.log('Seeding database...');
  console.log(`  Email: ${DEMO_EMAIL}`);

  await connectDB();

  // 1. Fetch market data
  console.log('  Fetching market data...');
  const { currentPrices, dailyPrices } = await fetchRealData();

  // 2. Upsert demo user
  console.log('  Creating demo user...');
  const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, 10);
  const user = await User.findOneAndUpdate(
    { email: DEMO_EMAIL },
    { name: DEMO_NAME, email: DEMO_EMAIL, password: hashedPassword },
    { upsert: true, new: true }
  );
  const userId = user._id.toString();

  // 3. Clean existing data for this user
  console.log('  Cleaning existing data...');
  await Promise.all([
    Portfolio.deleteMany({ userId }),
    Watchlist.deleteMany({ userId }),
    Alert.deleteMany({ userId }),
    PortfolioSnapshot.deleteMany({ userId }),
  ]);

  // 4. Create portfolio
  console.log('  Creating portfolio with holdings...');
  const holdings = buildHoldings(dailyPrices);
  const portfolio = await Portfolio.create({
    userId,
    name: 'My Portfolio',
    holdings,
  });
  const portfolioId = portfolio._id.toString();

  // 5. Create watchlist
  console.log('  Creating watchlist...');
  await Watchlist.create({ userId, symbols: WATCHLIST_SYMBOLS });

  // 6. Create alerts
  console.log('  Creating alerts...');
  const alertData = buildAlerts(currentPrices, portfolioId);
  await Alert.insertMany(alertData.map((a) => ({ ...a, userId })));

  // 7. Create portfolio snapshots
  console.log('  Creating 30-day portfolio snapshots...');
  const snapshotData = buildSnapshots(
    holdings.map((h) => ({
      symbol: h.symbol,
      quantity: h.quantity,
      avgBuyPrice: h.avgBuyPrice,
    })),
    dailyPrices,
    portfolioId
  );
  await PortfolioSnapshot.insertMany(
    snapshotData.map((s) => ({ ...s, userId }))
  );

  // Summary
  console.log('\nSeed complete:');
  console.log(`  User: ${DEMO_EMAIL} (${userId})`);
  console.log(`  Portfolio: ${portfolio.name} (${portfolioId})`);
  console.log(`  Holdings: ${holdings.length}`);
  console.log(`  Watchlist symbols: ${WATCHLIST_SYMBOLS.length}`);
  console.log(`  Alerts: ${alertData.length}`);
  console.log(`  Snapshots: ${snapshotData.length}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
