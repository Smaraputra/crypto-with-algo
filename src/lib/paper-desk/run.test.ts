// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  // getCandles goes through connectDB, which reads this and reuses the
  // connection mongoose already holds.
  process.env.MONGODB_URI = mongoServer.getUri();
  await mongoose.connect(mongoServer.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';
import { BOOK_START_EQUITY } from './books';

const HOUR = 3_600_000;
/** 2026-01-01T00:00:00Z, a clean 1h and 8h grid boundary. */
const T0 = Date.UTC(2026, 0, 1);

async function modules() {
  const run = await import('./run');
  const { PaperBook } = await import('@/lib/models/paper-book');
  const { PaperLedger } = await import('@/lib/models/paper-ledger');
  const { PaperTrade } = await import('@/lib/models/paper-trade');
  const { Candle } = await import('@/lib/models/candle');
  const { GlobalSignal } = await import('@/lib/models/global-signal');
  return { ...run, PaperBook, PaperLedger, PaperTrade, Candle, GlobalSignal };
}

/** Seeds `count` 1h BTCUSDT candles, flat at 100 unless `shape` says otherwise. */
async function seedCandles(
  Candle: Awaited<ReturnType<typeof modules>>['Candle'],
  count: number,
  shape: (i: number) => Partial<{ open: number; high: number; low: number; close: number }> = () => ({})
) {
  const docs = Array.from({ length: count }, (_, i) => {
    const s = shape(i);
    const close = s.close ?? 100;
    return {
      symbol: 'BTCUSDT',
      interval: '1h',
      timestamp: T0 + i * HOUR,
      open: s.open ?? close,
      high: s.high ?? close,
      low: s.low ?? close,
      close,
      volume: 10,
    };
  });
  await Candle.insertMany(docs);
}

/** Seeds one day_trading 1h signal per bar, with `scoreAt(i)` deciding the score. */
async function seedSignals(
  GlobalSignal: Awaited<ReturnType<typeof modules>>['GlobalSignal'],
  count: number,
  scoreAt: (i: number) => number,
  opts: { from?: number; configVersion?: number } = {}
) {
  const from = opts.from ?? 0;
  const docs = Array.from({ length: count - from }, (_, k) => {
    const i = from + k;
    const score = scoreAt(i);
    return {
      symbol: 'BTCUSDT',
      interval: '1h',
      tradingStyle: 'day_trading',
      score,
      tier: score >= 37 ? 'strong_buy' : score >= 29 ? 'buy' : score <= -29 ? 'sell' : 'neutral',
      confidence: 60,
      components: [],
      configVersion: opts.configVersion ?? SCORER_CONFIG_VERSION,
      candleTimestamp: T0 + i * HOUR,
      session: null,
      htfContext: null,
      expiresAt: new Date(T0 + (i + 100) * HOUR),
      createdAt: new Date(T0 + (i + 1) * HOUR + 20_000),
    };
  });
  await GlobalSignal.insertMany(docs);
}

/** Far enough past the last bar that any unscored bar is declared, not awaited. */
const NOW = T0 + 500 * HOUR;

/**
 * Bars 26 and 27 drift inside the stop/target band, so the live entry fills at
 * bar 26's open and the rule's own score exit closes the trade on bar 27
 * rather than a stop or target getting there first.
 */
function signalExitShape(i: number) {
  if (i === 26) return { open: 100.2, high: 100.4, low: 100.1, close: 100.3 };
  if (i === 27) return { open: 100.3, high: 100.4, low: 100.2, close: 100.35 };
  if (i >= 28) return { close: 100.35 };
  return {};
}

/** Enters on bar 25, holds through 26, and exits on bar 27's score. */
function signalExitScore(i: number) {
  if (i === 25 || i === 26) return 35;
  return 5;
}

/** Runs once to create the books, then rewinds the cursor so a catch-up is exercised. */
async function rewindTo(bar: number) {
  const m = await modules();
  await m.runPaperDesk(NOW);
  await m.PaperBook.updateOne(
    { tradingStyle: 'day_trading', interval: '1h' },
    { $set: { lastProcessedBarTime: T0 + bar * HOUR } }
  );
  return m;
}

describe('runPaperDesk: the first run', () => {
  it('creates every book and steps only the newest bar', async () => {
    const { runPaperDesk, PaperBook, Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30);
    await seedSignals(GlobalSignal, 30, () => 5);

    const report = await runPaperDesk(NOW);

    // Seven books: scalping 1m/5m, day trading 15m/1h, swing 4h/1d, position 1d.
    expect(report.books).toHaveLength(7);
    expect(await PaperBook.countDocuments()).toBe(7);

    const oneHour = report.books.find((b) => b.book === 'day_trading:1h')!;
    expect(oneHour.bars).toBe(1);
    expect(oneHour.cursor).toBe(T0 + 29 * HOUR);

    // The other books have no candles seeded, so they step nothing.
    for (const book of report.books.filter((b) => b.book !== 'day_trading:1h')) {
      expect(book.symbols).toBe(0);
      expect(book.bars).toBe(0);
    }
    expect(report.errors).toBe(0);
  });

  it('releases the lease so the next run can take it', async () => {
    const { runPaperDesk, PaperBook, Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 5);
    await seedSignals(GlobalSignal, 5, () => 5);
    await runPaperDesk(NOW);

    const book = await PaperBook.findOne({ tradingStyle: 'day_trading', interval: '1h' }).lean();
    expect(book?.leaseUntil).toBeNull();
    expect(book?.leaseOwner).toBeNull();
  });
});

describe('runPaperDesk: stepping forward', () => {
  it('opens a position on a score at the entry level and records it on the ledger', async () => {
    const { Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30);
    // Decisive from bar 25 on, so the position is still open when the run ends.
    await seedSignals(GlobalSignal, 30, (i) => (i >= 25 ? 35 : 5));
    const { runPaperDesk, PaperLedger } = await rewindTo(20);

    const report = await runPaperDesk(NOW);
    const book = report.books.find((b) => b.book === 'day_trading:1h')!;
    expect(book.bars).toBe(9);
    expect(book.opened).toBe(1);

    const ledger = await PaperLedger.findOne({ tradingStyle: 'day_trading', interval: '1h', symbol: 'BTCUSDT' }).lean();
    expect(ledger?.position).not.toBeNull();
    expect(ledger?.position?.side).toBe('long');
    expect(ledger?.position?.entryTime).toBe(T0 + 25 * HOUR);
    expect(ledger?.position?.entryConfigVersion).toBe(SCORER_CONFIG_VERSION);
    // The ticket's own rule: a stop floored at five taker round trips on flat bars.
    expect(ledger?.position?.stopPrice).toBeCloseTo(99.5, 6);
  });

  it('books a closed trade on both tracks, with the live entry at the next bar open', async () => {
    const { Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30, signalExitShape);
    await seedSignals(GlobalSignal, 30, signalExitScore);
    const { runPaperDesk, PaperTrade } = await rewindTo(20);

    await runPaperDesk(NOW);

    const trade = await PaperTrade.findOne({ symbol: 'BTCUSDT' }).lean();
    expect(trade).not.toBeNull();
    // Bar 27's score of 5 is below the 7.25 exit level, so the rule closes it.
    expect(trade?.exitReason).toBe('signal');
    expect(trade?.entryTime).toBe(T0 + 25 * HOUR);
    expect(trade?.exitTime).toBe(T0 + 27 * HOUR);
    // The engine books the signal bar's close after 3 bps of slippage.
    expect(trade?.engine.entryPrice).toBeCloseTo(100.03, 6);
    // A live order could only have filled at bar 26's open of 100.2.
    expect(trade?.executable.filled).toBe(true);
    expect(trade?.executable.entryPrice).toBeCloseTo(100.2 * 1.0003, 6);
    expect(trade?.executable.entryDelayBars).toBe(1);
    expect(trade?.executable.gappedStop).toBe(false);
    // A long that entered a point higher earns a point less on the same exit.
    expect(trade?.executable.pnl).toBeLessThan(trade!.engine.pnl);
    expect(trade?.entryConfigVersion).toBe(SCORER_CONFIG_VERSION);
  });

  it('is idempotent: re-stepping the same bars neither duplicates a trade nor moves the equity', async () => {
    const { Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30, signalExitShape);
    await seedSignals(GlobalSignal, 30, signalExitScore);
    const { runPaperDesk, PaperBook, PaperLedger, PaperTrade } = await rewindTo(20);

    await runPaperDesk(NOW);
    const first = await PaperLedger.findOne({ symbol: 'BTCUSDT', interval: '1h' }).lean();
    const trades = await PaperTrade.countDocuments();

    // Rewind and run the identical window again.
    await PaperBook.updateOne(
      { tradingStyle: 'day_trading', interval: '1h' },
      { $set: { lastProcessedBarTime: T0 + 20 * HOUR } }
    );
    await runPaperDesk(NOW);

    expect(await PaperTrade.countDocuments()).toBe(trades);
    const second = await PaperLedger.findOne({ symbol: 'BTCUSDT', interval: '1h' }).lean();
    expect(second?.equity).toBeCloseTo(first!.equity, 10);
    expect(second?.executableEquity).toBeCloseTo(first!.executableEquity, 10);
    expect(second?.trades).toBe(first?.trades);
  });

  it('records the aggregate exposure the book would have needed', async () => {
    const { Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30);
    await seedSignals(GlobalSignal, 30, (i) => (i >= 25 ? 35 : 5));
    const { runPaperDesk, PaperBook } = await rewindTo(20);

    await runPaperDesk(NOW);
    const book = await PaperBook.findOne({ tradingStyle: 'day_trading', interval: '1h' }).lean();
    // One symbol seeded, 1% risk over a 0.5% stop, so about 2x on that ledger.
    expect(book!.peakNotional).toBeGreaterThan(0);
    expect(book!.peakLeverage).toBeGreaterThan(1);
  });
});

describe('runPaperDesk: the scorer-version epoch', () => {
  it('reads only the current scorer version: another version reads as unscored', async () => {
    const { Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30);
    await seedSignals(GlobalSignal, 30, (i) => (i >= 25 ? 35 : 5), { configVersion: SCORER_CONFIG_VERSION - 1 });
    const { runPaperDesk } = await rewindTo(20);

    const report = await runPaperDesk(NOW);
    const book = report.books.find((b) => b.book === 'day_trading:1h')!;
    expect(book.opened).toBe(0);
    expect(book.missingScoreBars).toBeGreaterThan(0);
  });

  it('closes an earlier version position as epoch_end, books it under that version, and restarts the ledger', async () => {
    const { Candle, GlobalSignal } = await modules();
    // Bars 0..29, decisive from 25, so a position is open when the first run ends.
    await seedCandles(Candle, 35);
    await seedSignals(GlobalSignal, 30, (i) => (i >= 25 ? 35 : 5));
    const { runPaperDesk, PaperBook, PaperLedger, PaperTrade } = await rewindTo(20);
    await runPaperDesk(T0 + 30 * HOUR + 60_000);
    expect((await PaperLedger.findOne({ symbol: 'BTCUSDT', interval: '1h' }).lean())?.position).not.toBeNull();

    // Pretend that run and its position belong to the previous scorer version.
    await PaperBook.updateOne(
      { tradingStyle: 'day_trading', interval: '1h' },
      { $set: { epochConfigVersion: SCORER_CONFIG_VERSION - 1, peakNotional: 999, missingScoreBars: 7 } }
    );
    await PaperLedger.updateOne(
      { symbol: 'BTCUSDT', interval: '1h' },
      { $set: { 'position.entryConfigVersion': SCORER_CONFIG_VERSION - 1 } }
    );
    // The new version scores bars 30..34, still decisive.
    await seedSignals(GlobalSignal, 35, () => 35, { from: 30 });

    const report = await runPaperDesk(NOW);
    const book = report.books.find((b) => b.book === 'day_trading:1h')!;
    expect(book.epochClosed).toBe(1);

    const epochTrade = await PaperTrade.findOne({ symbol: 'BTCUSDT', exitReason: 'epoch_end' }).lean();
    expect(epochTrade).not.toBeNull();
    expect(epochTrade?.entryConfigVersion).toBe(SCORER_CONFIG_VERSION - 1);
    // Closed at the first stepped bar's close (bar 30), and nothing re-opened on that bar.
    expect(epochTrade?.exitTime).toBe(T0 + 30 * HOUR);

    const ledger = await PaperLedger.findOne({ symbol: 'BTCUSDT', interval: '1h' }).lean();
    // A new-version position opened on bar 31, sized from a fresh ledger.
    expect(ledger?.position?.entryConfigVersion).toBe(SCORER_CONFIG_VERSION);
    expect(ledger?.position?.entryTime).toBe(T0 + 31 * HOUR);
    expect(ledger?.equity).toBe(BOOK_START_EQUITY);
    expect(ledger?.trades).toBe(0);

    const stored = await PaperBook.findOne({ tradingStyle: 'day_trading', interval: '1h' }).lean();
    expect(stored?.epochConfigVersion).toBe(SCORER_CONFIG_VERSION);
    expect(stored?.epochStartBarTime).toBe(T0 + 30 * HOUR);
    expect(stored?.peakNotional).not.toBe(999);
    expect(stored?.missingScoreBars).toBeLessThan(7);
  });
});

describe('runPaperDesk: a missing score is not a decision', () => {
  it('steps a bar with no signal as unscored once a later bar has been scored', async () => {
    const { Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30);
    await seedSignals(GlobalSignal, 30, () => 5);
    // Punch a hole: bar 24 has no signal row at all.
    await GlobalSignal.deleteOne({ candleTimestamp: T0 + 24 * HOUR });
    const { runPaperDesk } = await rewindTo(20);

    const report = await runPaperDesk(NOW);
    const book = report.books.find((b) => b.book === 'day_trading:1h')!;
    expect(book.bars).toBe(9);
    expect(book.missingScoreBars).toBe(1);
    expect(book.pendingBars).toBe(0);
  });

  it('holds a bar back while its score may still arrive', async () => {
    const { Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 30);
    await seedSignals(GlobalSignal, 29, () => 5); // the last bar has no signal yet
    const { runPaperDesk, PaperBook } = await rewindTo(20);

    // A "now" just after the last bar closed: within two compute cadences, so
    // the score is still expected rather than lost.
    const soon = T0 + 30 * HOUR + 60_000;
    const report = await runPaperDesk(soon);
    const book = report.books.find((b) => b.book === 'day_trading:1h')!;
    expect(book.bars).toBe(8);
    expect(book.pendingBars).toBe(1);
    expect(book.cursor).toBe(T0 + 28 * HOUR);

    const stored = await PaperBook.findOne({ tradingStyle: 'day_trading', interval: '1h' }).lean();
    expect(stored?.lastProcessedBarTime).toBe(T0 + 28 * HOUR);
  });

  it('still checks the stop on an unscored bar, so a held position is never unmanaged', async () => {
    const { Candle, GlobalSignal } = await modules();
    // Enter on bar 25 at 100 with a 0.5% stop at 99.5; bar 27 trades down to 99.
    await seedCandles(Candle, 30, (i) => (i === 27 ? { open: 100, high: 100, low: 99, close: 99 } : {}));
    await seedSignals(GlobalSignal, 30, (i) => (i === 25 ? 35 : 35));
    // Bar 27 is unscored, so only the stop can act on it.
    await GlobalSignal.deleteOne({ candleTimestamp: T0 + 27 * HOUR });
    const { runPaperDesk, PaperTrade } = await rewindTo(20);

    await runPaperDesk(NOW);
    const trade = await PaperTrade.findOne({ symbol: 'BTCUSDT' }).lean();
    expect(trade?.exitReason).toBe('stop_loss');
    expect(trade?.exitTime).toBe(T0 + 27 * HOUR);
  });
});

describe('runPaperDesk: the lease', () => {
  it('skips a book another run still holds', async () => {
    const { runPaperDesk, PaperBook, Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 10);
    await seedSignals(GlobalSignal, 10, () => 5);
    await runPaperDesk(NOW);

    await PaperBook.updateOne(
      { tradingStyle: 'day_trading', interval: '1h' },
      { $set: { leaseUntil: new Date(NOW + 60_000), leaseOwner: 'another-run' } }
    );

    const report = await runPaperDesk(NOW);
    const book = report.books.find((b) => b.book === 'day_trading:1h')!;
    expect(book.bars).toBeNull();
    expect(report.leasedOut).toBe(1);

    // The other run's lease is left intact.
    const stored = await PaperBook.findOne({ tradingStyle: 'day_trading', interval: '1h' }).lean();
    expect(stored?.leaseOwner).toBe('another-run');
  });

  it('takes over a lease that has expired', async () => {
    const { runPaperDesk, PaperBook, Candle, GlobalSignal } = await modules();
    await seedCandles(Candle, 10);
    await seedSignals(GlobalSignal, 10, () => 5);
    await runPaperDesk(NOW);
    await PaperBook.updateOne(
      { tradingStyle: 'day_trading', interval: '1h' },
      { $set: { leaseUntil: new Date(NOW - 1), leaseOwner: 'crashed-run' } }
    );

    const report = await runPaperDesk(NOW);
    expect(report.books.find((b) => b.book === 'day_trading:1h')!.bars).not.toBeNull();
  });
});

describe('isUnscored', () => {
  it('declares a bar unscored once a later bar has been scored', async () => {
    const { isUnscored } = await modules();
    expect(isUnscored(1000, 1000, 1000, 300)).toBe(true);
    expect(isUnscored(1000, 900, 1000, 300)).toBe(false);
  });

  it('declares a bar unscored once it is more than two compute cadences old', async () => {
    const { isUnscored } = await modules();
    // A 5-minute cadence: still expected at 9 minutes, lost at 11.
    expect(isUnscored(0, null, 9 * 60_000, 300)).toBe(false);
    expect(isUnscored(0, null, 11 * 60_000, 300)).toBe(true);
  });
});

describe('computeCadenceSeconds', () => {
  it('reads each style cadence from the cron registry', async () => {
    const { computeCadenceSeconds } = await modules();
    expect(computeCadenceSeconds('scalping')).toBe(60);
    expect(computeCadenceSeconds('day_trading')).toBe(300);
    expect(computeCadenceSeconds('swing_trading')).toBe(900);
    expect(computeCadenceSeconds('position_trading')).toBe(3600);
  });
});
