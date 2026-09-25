/**
 * THROWAWAY local seeder for the calibration dashboard visual check.
 *
 * Writes synthetic SignalOutcome rows tagged with a marker configVersion range
 * so they can be deleted again precisely. Never run against production.
 */
import mongoose from 'mongoose';

import { connectDB } from '@/lib/mongodb';

async function main() {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/cryptowithalgo';
  await connectDB();

  const SignalOutcome = mongoose.connection.collection('signaloutcomes');
  await SignalOutcome.deleteMany({ symbol: { $regex: /^SEED/ } });

  const symbols = ['SEEDBTC', 'SEEDETH', 'SEEDBNB', 'SEEDSOL', 'SEEDXRP'];
  const HOUR = 3_600_000;
  const start = Date.now() - 45 * 24 * HOUR;

  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };

  const docs: Record<string, unknown>[] = [];
  for (let bar = 0; bar < 24 * 45; bar++) {
    const candleTimestamp = start + bar * HOUR;
    // A weak common factor across symbols at each bar, which is what makes the
    // cross-section correlated the way the real record is.
    const common = gauss() * 0.3;
    for (const symbol of symbols) {
      const score = Math.round(gauss() * 18);
      const abs = Math.abs(score);
      const tier =
        abs < 29 ? 'neutral' : score > 0 ? (abs >= 37 ? 'strong_buy' : 'buy') : abs >= 37 ? 'strong_sell' : 'sell';
      // A deliberately tiny true edge, swamped by noise: roughly what a real
      // record looks like, so the charts are exercised on a realistic shape.
      const forwardReturnPercent = common + gauss() * 0.9 + score * 0.0015;
      docs.push({
        signalId: new mongoose.Types.ObjectId(),
        source: 'composite',
        symbol,
        interval: '1h',
        tradingStyle: 'day_trading',
        tier,
        score,
        configVersion: bar < 24 * 30 ? 6 : 7,
        candleTimestamp,
        horizonBars: 24,
        resolveAt: candleTimestamp + 25 * HOUR,
        status: 'resolved',
        entryPrice: 50000,
        forwardReturnPercent,
        mfePercent: Math.abs(forwardReturnPercent) + Math.abs(gauss()) * 0.4,
        maePercent: -Math.abs(gauss()) * 0.5,
        resolvedAt: new Date(candleTimestamp + 25 * HOUR),
        createdAt: new Date(candleTimestamp),
      });
    }
  }

  // A handful still pending, so the coverage tile has something to show.
  for (let i = 0; i < 40; i++) {
    docs.push({
      signalId: new mongoose.Types.ObjectId(),
      source: 'composite',
      symbol: 'SEEDBTC',
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: 'neutral',
      score: 3,
      configVersion: 7,
      candleTimestamp: Date.now() - i * HOUR,
      horizonBars: 24,
      resolveAt: Date.now() + HOUR,
      status: 'pending',
      entryPrice: null,
      forwardReturnPercent: null,
      mfePercent: null,
      maePercent: null,
      resolvedAt: null,
      createdAt: new Date(),
    });
  }

  await SignalOutcome.insertMany(docs);
  console.log('seeded', docs.length, 'rows');
  await mongoose.disconnect();
}

main();
