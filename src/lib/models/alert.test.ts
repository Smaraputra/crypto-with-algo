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

describe('Alert model', () => {
  async function getAlert() {
    const { Alert } = await import('./alert');
    return Alert;
  }

  it('creates a price_above alert with required fields', async () => {
    const Alert = await getAlert();
    const alert = await Alert.create({
      userId: 'user-1',
      symbol: 'BTCUSDT',
      type: 'price_above',
      targetPrice: 100000,
    });

    expect(alert.userId).toBe('user-1');
    expect(alert.symbol).toBe('BTCUSDT');
    expect(alert.type).toBe('price_above');
    expect(alert.targetPrice).toBe(100000);
    expect(alert.status).toBe('active');
    expect(alert.recurring).toBe(false);
    expect(alert.cooldownMinutes).toBe(60);
    expect(alert.message).toBe('');
    expect(alert.portfolioId).toBeNull();
    expect(alert.triggeredAt).toBeNull();
    expect(alert.notifiedAt).toBeNull();
    expect(alert.lastTriggeredAt).toBeNull();
    expect(alert._id).toBeDefined();
  });

  it('creates a price_below alert', async () => {
    const Alert = await getAlert();
    const alert = await Alert.create({
      userId: 'user-1',
      symbol: 'ETHUSDT',
      type: 'price_below',
      targetPrice: 2000,
      message: 'Buy the dip',
    });

    expect(alert.type).toBe('price_below');
    expect(alert.targetPrice).toBe(2000);
    expect(alert.message).toBe('Buy the dip');
  });

  it('creates a price_change_pct alert with referencePrice', async () => {
    const Alert = await getAlert();
    const alert = await Alert.create({
      userId: 'user-1',
      symbol: 'BTCUSDT',
      type: 'price_change_pct',
      percentChange: 5,
      referencePrice: 95000,
    });

    expect(alert.type).toBe('price_change_pct');
    expect(alert.percentChange).toBe(5);
    expect(alert.referencePrice).toBe(95000);
  });

  it('creates a portfolio_value_above alert', async () => {
    const Alert = await getAlert();
    const alert = await Alert.create({
      userId: 'user-1',
      portfolioId: 'portfolio-1',
      type: 'portfolio_value_above',
      targetPrice: 50000,
    });

    expect(alert.portfolioId).toBe('portfolio-1');
    expect(alert.type).toBe('portfolio_value_above');
    expect(alert.targetPrice).toBe(50000);
  });

  it('creates a holding_change_pct alert', async () => {
    const Alert = await getAlert();
    const alert = await Alert.create({
      userId: 'user-1',
      portfolioId: 'portfolio-1',
      symbol: 'BTCUSDT',
      type: 'holding_change_pct',
      percentChange: -10,
    });

    expect(alert.type).toBe('holding_change_pct');
    expect(alert.percentChange).toBe(-10);
    expect(alert.portfolioId).toBe('portfolio-1');
    expect(alert.symbol).toBe('BTCUSDT');
  });

  it('rejects creation without required userId', async () => {
    const Alert = await getAlert();
    await expect(
      Alert.create({ type: 'price_above', symbol: 'BTCUSDT', targetPrice: 100000 })
    ).rejects.toThrow();
  });

  it('rejects creation without required type', async () => {
    const Alert = await getAlert();
    await expect(
      Alert.create({ userId: 'user-1', symbol: 'BTCUSDT' })
    ).rejects.toThrow();
  });

  it('rejects invalid alert type enum', async () => {
    const Alert = await getAlert();
    await expect(
      Alert.create({ userId: 'user-1', symbol: 'BTCUSDT', type: 'invalid_type' })
    ).rejects.toThrow();
  });

  it('rejects invalid status enum', async () => {
    const Alert = await getAlert();
    await expect(
      Alert.create({
        userId: 'user-1',
        symbol: 'BTCUSDT',
        type: 'price_above',
        status: 'invalid_status',
      })
    ).rejects.toThrow();
  });

  it('sets timestamps automatically', async () => {
    const Alert = await getAlert();
    const alert = await Alert.create({
      userId: 'user-1',
      symbol: 'BTCUSDT',
      type: 'price_above',
      targetPrice: 100000,
    });

    expect(alert.createdAt).toBeInstanceOf(Date);
    expect(alert.updatedAt).toBeInstanceOf(Date);
  });

  it('supports recurring alerts with custom cooldown', async () => {
    const Alert = await getAlert();
    const alert = await Alert.create({
      userId: 'user-1',
      symbol: 'BTCUSDT',
      type: 'price_above',
      targetPrice: 100000,
      recurring: true,
      cooldownMinutes: 30,
    });

    expect(alert.recurring).toBe(true);
    expect(alert.cooldownMinutes).toBe(30);
  });

  it('verifies indexes exist', async () => {
    const Alert = await getAlert();
    await Alert.syncIndexes();
    const indexes = await Alert.collection.indexes();

    const indexKeys = indexes.map((idx) => Object.keys(idx.key));

    expect(indexKeys).toContainEqual(['userId', 'status']);
    expect(indexKeys).toContainEqual(['status']);
  });

  it('queries efficiently by userId and status', async () => {
    const Alert = await getAlert();
    await Alert.create({
      userId: 'user-1',
      symbol: 'BTCUSDT',
      type: 'price_above',
      targetPrice: 100000,
      status: 'active',
    });
    await Alert.create({
      userId: 'user-1',
      symbol: 'ETHUSDT',
      type: 'price_below',
      targetPrice: 2000,
      status: 'triggered',
    });
    await Alert.create({
      userId: 'user-2',
      symbol: 'BTCUSDT',
      type: 'price_above',
      targetPrice: 90000,
      status: 'active',
    });

    const user1Active = await Alert.find({ userId: 'user-1', status: 'active' });
    expect(user1Active).toHaveLength(1);
    expect(user1Active[0].symbol).toBe('BTCUSDT');

    const allActive = await Alert.find({ status: 'active' });
    expect(allActive).toHaveLength(2);
  });
});
