// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

function makeEntryData(overrides = {}) {
  return {
    userId: 'user-1',
    symbol: 'BTCUSDT',
    interval: '1h',
    signalScore: 45,
    signalTier: 'buy',
    action: 'buy',
    entryPrice: 42000,
    notes: 'Strong momentum',
    ...overrides,
  };
}

describe('JournalEntry model', () => {
  async function getModel() {
    const { JournalEntry } = await import('./journal-entry');
    return JournalEntry;
  }

  it('creates an entry with required fields only', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(makeEntryData());

    expect(entry.userId).toBe('user-1');
    expect(entry.symbol).toBe('BTCUSDT');
    expect(entry.action).toBe('buy');
    expect(entry.entryPrice).toBe(42000);
    expect(entry._id).toBeDefined();
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('defaults new fields correctly', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(makeEntryData());

    expect(entry.tags).toEqual([]);
    expect(entry.indicatorSnapshot).toBeNull();
    expect(entry.strategyId).toBeNull();
    expect(entry.backtestResultId).toBeNull();
    expect(entry.lessonsLearned).toBe('');
    expect(entry.setupType).toBe('');
    expect(entry.marketCondition).toBeNull();
    expect(entry.sentiment).toBeNull();
    expect(entry.reviewedAt).toBeNull();
    expect(entry.exitPrice).toBeNull();
    expect(entry.outcomePnlPercent).toBeNull();
    expect(entry.reviewHistory).toEqual([]);
  });

  it('stores tags array', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(
      makeEntryData({ tags: ['breakout', 'trend-follow'] })
    );

    expect(entry.tags).toEqual(['breakout', 'trend-follow']);
  });

  it('stores indicator snapshot as mixed type', async () => {
    const JournalEntry = await getModel();
    const snapshot = {
      rsi: 62,
      macdLine: 150,
      ema12: 42100,
      superTrendDirection: 'up',
    };
    const entry = await JournalEntry.create(
      makeEntryData({ indicatorSnapshot: snapshot })
    );

    expect(entry.indicatorSnapshot).toEqual(snapshot);
  });

  it('stores sentiment data', async () => {
    const JournalEntry = await getModel();
    const sentiment = { fearGreedIndex: 65, fearGreedLabel: 'Greed' };
    const entry = await JournalEntry.create(
      makeEntryData({ sentiment })
    );

    expect(entry.sentiment).toEqual(sentiment);
  });

  it('stores market condition enum', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(
      makeEntryData({ marketCondition: 'trending_up' })
    );

    expect(entry.marketCondition).toBe('trending_up');
  });

  it('rejects invalid market condition', async () => {
    const JournalEntry = await getModel();
    await expect(
      JournalEntry.create(makeEntryData({ marketCondition: 'invalid' }))
    ).rejects.toThrow();
  });

  it('stores strategy and backtest references', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(
      makeEntryData({ strategyId: 'strat-1', backtestResultId: 'bt-1' })
    );

    expect(entry.strategyId).toBe('strat-1');
    expect(entry.backtestResultId).toBe('bt-1');
  });

  it('stores lessons learned', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(
      makeEntryData({ lessonsLearned: 'Should have waited for confirmation' })
    );

    expect(entry.lessonsLearned).toBe('Should have waited for confirmation');
  });

  it('stores reviewHistory array', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(
      makeEntryData({
        reviewHistory: [
          { lessonsLearned: 'First review', reviewedAt: new Date('2025-01-10') },
        ],
      })
    );

    expect(entry.reviewHistory).toHaveLength(1);
    expect(entry.reviewHistory[0].lessonsLearned).toBe('First review');
    expect(entry.reviewHistory[0].reviewedAt).toBeInstanceOf(Date);
  });

  it('rejects sentiment with fearGreedIndex out of range', async () => {
    const JournalEntry = await getModel();
    await expect(
      JournalEntry.create(
        makeEntryData({ sentiment: { fearGreedIndex: 150, fearGreedLabel: 'Extreme' } })
      )
    ).rejects.toThrow();
  });

  it('rejects sentiment with negative fearGreedIndex', async () => {
    const JournalEntry = await getModel();
    await expect(
      JournalEntry.create(
        makeEntryData({ sentiment: { fearGreedIndex: -5, fearGreedLabel: 'Invalid' } })
      )
    ).rejects.toThrow();
  });

  it('allows null sentiment', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(
      makeEntryData({ sentiment: null })
    );
    expect(entry.sentiment).toBeNull();
  });

  it('rejects invalid action enum', async () => {
    const JournalEntry = await getModel();
    await expect(
      JournalEntry.create(makeEntryData({ action: 'invalid' }))
    ).rejects.toThrow();
  });

  it('rejects missing required fields', async () => {
    const JournalEntry = await getModel();
    await expect(
      JournalEntry.create({ userId: 'user-1' })
    ).rejects.toThrow();
  });

  it('queries by userId and tags', async () => {
    const JournalEntry = await getModel();
    await JournalEntry.create(makeEntryData({ tags: ['breakout'] }));
    await JournalEntry.create(makeEntryData({ tags: ['reversal'], symbol: 'ETHUSDT' }));
    await JournalEntry.create(makeEntryData({ tags: ['breakout', 'reversal'], symbol: 'SOLUSDT' }));

    const breakoutEntries = await JournalEntry.find({
      userId: 'user-1',
      tags: 'breakout',
    });
    expect(breakoutEntries).toHaveLength(2);
  });

  it('verifies indexes exist', async () => {
    const JournalEntry = await getModel();
    await JournalEntry.syncIndexes();
    const indexes = await JournalEntry.collection.indexes();

    const indexKeys = indexes.map((idx) => Object.keys(idx.key));
    expect(indexKeys).toContainEqual(['userId', 'createdAt']);
    expect(indexKeys).toContainEqual(['userId', 'symbol']);
    expect(indexKeys).toContainEqual(['userId', 'tags']);
  });

  it('sets timestamps automatically', async () => {
    const JournalEntry = await getModel();
    const entry = await JournalEntry.create(makeEntryData());

    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.updatedAt).toBeInstanceOf(Date);
  });

  it('exports MAX_JOURNAL_ENTRIES_PER_USER as 1000', async () => {
    const { MAX_JOURNAL_ENTRIES_PER_USER } = await import('./journal-entry');
    expect(MAX_JOURNAL_ENTRIES_PER_USER).toBe(1000);
  });

  it('exports MARKET_CONDITIONS', async () => {
    const { MARKET_CONDITIONS } = await import('./journal-entry');
    expect(MARKET_CONDITIONS).toContain('trending_up');
    expect(MARKET_CONDITIONS).toContain('trending_down');
    expect(MARKET_CONDITIONS).toContain('ranging');
    expect(MARKET_CONDITIONS).toContain('volatile');
    expect(MARKET_CONDITIONS).toContain('calm');
    expect(MARKET_CONDITIONS).toHaveLength(5);
  });
});
