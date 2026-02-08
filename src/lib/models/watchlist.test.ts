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

describe('Watchlist model', () => {
  async function getWatchlist() {
    const { Watchlist } = await import('./watchlist');
    return Watchlist;
  }

  it('creates watchlist with userId and default symbols', async () => {
    const Watchlist = await getWatchlist();
    const watchlist = await Watchlist.create({ userId: 'user-1' });

    expect(watchlist.userId).toBe('user-1');
    expect(watchlist.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(watchlist._id).toBeDefined();
  });

  it('enforces unique userId constraint', async () => {
    const Watchlist = await getWatchlist();
    await Watchlist.syncIndexes();
    await Watchlist.create({ userId: 'user-dupe' });

    await expect(
      Watchlist.create({ userId: 'user-dupe' })
    ).rejects.toThrow();
  });

  it('allows custom symbols array', async () => {
    const Watchlist = await getWatchlist();
    const watchlist = await Watchlist.create({
      userId: 'user-2',
      symbols: ['DOGEUSDT', 'XRPUSDT'],
    });

    expect(watchlist.symbols).toEqual(['DOGEUSDT', 'XRPUSDT']);
  });

  it('sets timestamps automatically', async () => {
    const Watchlist = await getWatchlist();
    const watchlist = await Watchlist.create({ userId: 'user-3' });

    expect(watchlist.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects creation without required userId', async () => {
    const Watchlist = await getWatchlist();
    await expect(Watchlist.create({})).rejects.toThrow();
  });
});
