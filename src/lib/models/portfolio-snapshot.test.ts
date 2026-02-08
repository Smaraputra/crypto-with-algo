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

describe('PortfolioSnapshot model', () => {
  async function getModel() {
    const { PortfolioSnapshot } = await import('./portfolio-snapshot');
    return PortfolioSnapshot;
  }

  const validSnapshot = {
    userId: 'user-1',
    portfolioId: 'portfolio-1',
    date: new Date('2024-01-15T12:30:00.000Z'),
    totalValue: 26000,
    totalCost: 25010,
    unrealizedPnl: 990,
    unrealizedPnlPercent: 3.96,
    holdings: [
      { symbol: 'BTCUSDT', quantity: 0.5, price: 42000, value: 21000 },
      { symbol: 'ETHUSDT', quantity: 2.0, price: 2500, value: 5000 },
    ],
  };

  it('creates a snapshot with all required fields', async () => {
    const Snapshot = await getModel();
    const doc = await Snapshot.create(validSnapshot);

    expect(doc.userId).toBe('user-1');
    expect(doc.portfolioId).toBe('portfolio-1');
    expect(doc.totalValue).toBe(26000);
    expect(doc.totalCost).toBe(25010);
    expect(doc.unrealizedPnl).toBe(990);
    expect(doc.unrealizedPnlPercent).toBe(3.96);
    expect(doc.holdings).toHaveLength(2);
    expect(doc._id).toBeDefined();
  });

  it('truncates date to midnight UTC on save', async () => {
    const Snapshot = await getModel();
    const doc = await Snapshot.create(validSnapshot);

    expect(doc.date.getUTCHours()).toBe(0);
    expect(doc.date.getUTCMinutes()).toBe(0);
    expect(doc.date.getUTCSeconds()).toBe(0);
    expect(doc.date.getUTCMilliseconds()).toBe(0);
    expect(doc.date.toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('rejects creation without required userId', async () => {
    const Snapshot = await getModel();
    const { userId: _userId, ...noUser } = validSnapshot;
    await expect(Snapshot.create(noUser)).rejects.toThrow();
  });

  it('rejects creation without required portfolioId', async () => {
    const Snapshot = await getModel();
    const { portfolioId: _portfolioId, ...noPortfolio } = validSnapshot;
    await expect(Snapshot.create(noPortfolio)).rejects.toThrow();
  });

  it('rejects creation without required date', async () => {
    const Snapshot = await getModel();
    const { date: _date, ...noDate } = validSnapshot;
    await expect(Snapshot.create(noDate)).rejects.toThrow();
  });

  it('rejects creation without required totalValue', async () => {
    const Snapshot = await getModel();
    const { totalValue: _totalValue, ...noValue } = validSnapshot;
    await expect(Snapshot.create(noValue)).rejects.toThrow();
  });

  it('sets timestamps automatically', async () => {
    const Snapshot = await getModel();
    const doc = await Snapshot.create(validSnapshot);

    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it('creates snapshot with empty holdings array', async () => {
    const Snapshot = await getModel();
    const doc = await Snapshot.create({
      ...validSnapshot,
      holdings: [],
    });

    expect(doc.holdings).toEqual([]);
  });

  it('enforces compound unique index on portfolioId + date', async () => {
    const Snapshot = await getModel();
    await Snapshot.syncIndexes();
    await Snapshot.create(validSnapshot);

    await expect(
      Snapshot.create({
        ...validSnapshot,
        userId: 'user-2',
        totalValue: 30000,
      })
    ).rejects.toThrow();
  });

  it('allows same date for different portfolios', async () => {
    const Snapshot = await getModel();
    await Snapshot.syncIndexes();
    await Snapshot.create(validSnapshot);

    const doc2 = await Snapshot.create({
      ...validSnapshot,
      portfolioId: 'portfolio-2',
    });

    expect(doc2.portfolioId).toBe('portfolio-2');
  });

  it('allows same portfolio on different dates', async () => {
    const Snapshot = await getModel();
    await Snapshot.syncIndexes();
    await Snapshot.create(validSnapshot);

    const doc2 = await Snapshot.create({
      ...validSnapshot,
      date: new Date('2024-01-16T00:00:00.000Z'),
    });

    expect(doc2.date.toISOString()).toBe('2024-01-16T00:00:00.000Z');
  });

  it('queries by portfolioId and date range', async () => {
    const Snapshot = await getModel();
    for (let i = 1; i <= 5; i++) {
      await Snapshot.create({
        ...validSnapshot,
        date: new Date(`2024-01-${String(i).padStart(2, '0')}T00:00:00.000Z`),
        totalValue: 25000 + i * 1000,
      });
    }

    const results = await Snapshot.find({
      portfolioId: 'portfolio-1',
      date: {
        $gte: new Date('2024-01-02T00:00:00.000Z'),
        $lte: new Date('2024-01-04T00:00:00.000Z'),
      },
    }).sort({ date: 1 });

    expect(results).toHaveLength(3);
    expect(results[0].totalValue).toBe(27000);
    expect(results[2].totalValue).toBe(29000);
  });

  it('verifies indexes exist', async () => {
    const Snapshot = await getModel();
    await Snapshot.syncIndexes();
    const indexes = await Snapshot.collection.indexes();
    const indexKeys = indexes.map((idx) => Object.keys(idx.key));

    expect(indexKeys).toContainEqual(['userId']);
    expect(indexKeys).toContainEqual(['portfolioId', 'date']);
  });
});

describe('truncateToMidnightUTC', () => {
  it('truncates time to midnight UTC', async () => {
    const { truncateToMidnightUTC } = await import('./portfolio-snapshot');
    const result = truncateToMidnightUTC(new Date('2024-06-15T14:30:45.123Z'));
    expect(result.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  it('preserves dates already at midnight', async () => {
    const { truncateToMidnightUTC } = await import('./portfolio-snapshot');
    const result = truncateToMidnightUTC(new Date('2024-06-15T00:00:00.000Z'));
    expect(result.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  it('does not mutate the input date', async () => {
    const { truncateToMidnightUTC } = await import('./portfolio-snapshot');
    const original = new Date('2024-06-15T14:30:45.123Z');
    truncateToMidnightUTC(original);
    expect(original.toISOString()).toBe('2024-06-15T14:30:45.123Z');
  });
});
