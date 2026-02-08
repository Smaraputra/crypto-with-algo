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

describe('Portfolio model', () => {
  async function getPortfolio() {
    const { Portfolio } = await import('./portfolio');
    return Portfolio;
  }

  it('creates portfolio with userId and default name', async () => {
    const Portfolio = await getPortfolio();
    const portfolio = await Portfolio.create({ userId: 'user-1' });

    expect(portfolio.userId).toBe('user-1');
    expect(portfolio.name).toBe('My Portfolio');
    expect(portfolio.holdings).toEqual([]);
    expect(portfolio._id).toBeDefined();
  });

  it('creates portfolio with custom name', async () => {
    const Portfolio = await getPortfolio();
    const portfolio = await Portfolio.create({ userId: 'user-1', name: 'Trading' });

    expect(portfolio.name).toBe('Trading');
  });

  it('rejects creation without required userId', async () => {
    const Portfolio = await getPortfolio();
    await expect(Portfolio.create({ name: 'Test' })).rejects.toThrow();
  });

  it('creates portfolio with nested transactions in holdings', async () => {
    const Portfolio = await getPortfolio();
    const portfolio = await Portfolio.create({
      userId: 'user-1',
      holdings: [
        {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          quantity: 0.5,
          avgBuyPrice: 40000,
          transactions: [
            { type: 'buy', quantity: 0.5, price: 40000, date: new Date('2024-01-15') },
          ],
        },
      ],
    });

    expect(portfolio.holdings).toHaveLength(1);
    expect(portfolio.holdings[0].symbol).toBe('BTCUSDT');
    expect(portfolio.holdings[0].transactions).toHaveLength(1);
    expect(portfolio.holdings[0].transactions[0].type).toBe('buy');
    expect(portfolio.holdings[0].transactions[0]._id).toBeDefined();
  });

  it('validates transaction type enum', async () => {
    const Portfolio = await getPortfolio();
    await expect(
      Portfolio.create({
        userId: 'user-1',
        holdings: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            quantity: 1,
            avgBuyPrice: 40000,
            transactions: [{ type: 'transfer', quantity: 1, price: 40000 }],
          },
        ],
      })
    ).rejects.toThrow();
  });

  it('enforces compound unique index on userId + name', async () => {
    const Portfolio = await getPortfolio();
    await Portfolio.syncIndexes();
    await Portfolio.create({ userId: 'user-1', name: 'Main' });

    await expect(
      Portfolio.create({ userId: 'user-1', name: 'Main' })
    ).rejects.toThrow();
  });

  it('sets timestamps automatically', async () => {
    const Portfolio = await getPortfolio();
    const portfolio = await Portfolio.create({ userId: 'user-1' });

    expect(portfolio.createdAt).toBeInstanceOf(Date);
    expect(portfolio.updatedAt).toBeInstanceOf(Date);
  });

  it('allows multiple portfolios per user with different names', async () => {
    const Portfolio = await getPortfolio();
    await Portfolio.syncIndexes();

    const p1 = await Portfolio.create({ userId: 'user-1', name: 'Main' });
    const p2 = await Portfolio.create({ userId: 'user-1', name: 'Trading' });

    expect(p1.name).toBe('Main');
    expect(p2.name).toBe('Trading');

    const all = await Portfolio.find({ userId: 'user-1' });
    expect(all).toHaveLength(2);
  });

  it('allows same portfolio name for different users', async () => {
    const Portfolio = await getPortfolio();
    await Portfolio.syncIndexes();

    await Portfolio.create({ userId: 'user-1', name: 'Main' });
    const p2 = await Portfolio.create({ userId: 'user-2', name: 'Main' });

    expect(p2.userId).toBe('user-2');
    expect(p2.name).toBe('Main');
  });
});
