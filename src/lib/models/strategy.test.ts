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

describe('Strategy model', () => {
  async function getStrategy() {
    const { Strategy } = await import('./strategy');
    return Strategy;
  }

  it('creates a strategy with required fields', async () => {
    const Strategy = await getStrategy();
    const strategy = await Strategy.create({
      userId: 'user-1',
      name: 'BTC Momentum',
      symbols: ['BTCUSDT'],
    });

    expect(strategy.userId).toBe('user-1');
    expect(strategy.name).toBe('BTC Momentum');
    expect(strategy.symbols).toEqual(['BTCUSDT']);
    expect(strategy.intervals).toEqual(['1h']);
    expect(strategy.active).toBe(true);
    expect(strategy._id).toBeDefined();
  });

  it('sets default weights', async () => {
    const Strategy = await getStrategy();
    const strategy = await Strategy.create({
      userId: 'user-1',
      name: 'Default',
      symbols: ['BTCUSDT'],
    });

    expect(strategy.weights.trend).toBe(0.25);
    expect(strategy.weights.momentum).toBe(0.25);
    expect(strategy.weights.volume).toBe(0.15);
    expect(strategy.weights.volatility).toBe(0.10);
    expect(strategy.weights.futures).toBe(0.15);
    expect(strategy.weights.sentiment).toBe(0.10);
  });

  it('accepts custom weights', async () => {
    const Strategy = await getStrategy();
    const strategy = await Strategy.create({
      userId: 'user-1',
      name: 'Custom',
      symbols: ['BTCUSDT'],
      weights: {
        trend: 0.40,
        momentum: 0.30,
        volume: 0.10,
        volatility: 0.05,
        futures: 0.10,
        sentiment: 0.05,
      },
    });

    expect(strategy.weights.trend).toBe(0.40);
    expect(strategy.weights.momentum).toBe(0.30);
  });

  it('accepts multiple symbols and intervals', async () => {
    const Strategy = await getStrategy();
    const strategy = await Strategy.create({
      userId: 'user-1',
      name: 'Multi',
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      intervals: ['1h', '4h', '1d'],
    });

    expect(strategy.symbols).toHaveLength(3);
    expect(strategy.intervals).toHaveLength(3);
  });

  it('sets timestamps automatically', async () => {
    const Strategy = await getStrategy();
    const strategy = await Strategy.create({
      userId: 'user-1',
      name: 'Test',
      symbols: ['BTCUSDT'],
    });

    expect(strategy.createdAt).toBeInstanceOf(Date);
    expect(strategy.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects missing required fields', async () => {
    const Strategy = await getStrategy();
    await expect(Strategy.create({ userId: 'user-1' })).rejects.toThrow();
    await expect(Strategy.create({ name: 'Test' })).rejects.toThrow();
  });

  it('queries by userId', async () => {
    const Strategy = await getStrategy();
    await Strategy.create({ userId: 'user-1', name: 'S1', symbols: ['BTCUSDT'] });
    await Strategy.create({ userId: 'user-1', name: 'S2', symbols: ['ETHUSDT'] });
    await Strategy.create({ userId: 'user-2', name: 'S3', symbols: ['BTCUSDT'] });

    const user1Strategies = await Strategy.find({ userId: 'user-1' });
    expect(user1Strategies).toHaveLength(2);
  });

  it('supports active toggle', async () => {
    const Strategy = await getStrategy();
    const strategy = await Strategy.create({
      userId: 'user-1',
      name: 'Paused',
      symbols: ['BTCUSDT'],
      active: false,
    });

    expect(strategy.active).toBe(false);
  });

  it('verifies userId index exists', async () => {
    const Strategy = await getStrategy();
    await Strategy.syncIndexes();
    const indexes = await Strategy.collection.indexes();

    const indexKeys = indexes.map((idx) => Object.keys(idx.key));
    expect(indexKeys).toContainEqual(['userId']);
  });
});
