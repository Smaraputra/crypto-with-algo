// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { dropOutcomeTtl } from './drop-outcome-ttl';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

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

function collection() {
  return mongoose.connection.db!.collection('signaloutcomes');
}

async function indexNames(): Promise<string[]> {
  return (await collection().indexes()).map((i) => i.name as string).sort();
}

async function seed() {
  const c = collection();
  await c.insertMany([
    { symbol: 'BTCUSDT', source: 'composite', tradingStyle: 'day', interval: '1h', status: 'resolved', createdAt: new Date('2025-10-01') },
    { symbol: 'ETHUSDT', source: 'llm', tradingStyle: 'day', interval: '5m', status: 'pending', createdAt: new Date('2026-01-01') },
  ]);
  await c.createIndex({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });
  await c.createIndex({ symbol: 1, tradingStyle: 1, createdAt: -1 });
}

describe('dropOutcomeTtl', () => {
  it('drops only the createdAt TTL index and keeps the others', async () => {
    await seed();
    const result = await dropOutcomeTtl(collection(), { dryRun: false });
    expect(result.dropped).toBe('createdAt_1');
    const names = await indexNames();
    expect(names).not.toContain('createdAt_1');
    expect(names).toContain('symbol_1_tradingStyle_1_createdAt_-1');
    expect(names).toContain('_id_');
  });

  it('is a no-op when no TTL index exists', async () => {
    await seed();
    await collection().dropIndex('createdAt_1');
    const before = await indexNames();
    const result = await dropOutcomeTtl(collection(), { dryRun: false });
    expect(result.dropped).toBeNull();
    expect(await indexNames()).toEqual(before);
  });

  it('does not drop a plain createdAt index without expireAfterSeconds', async () => {
    await collection().insertOne({ symbol: 'BTCUSDT' });
    await collection().createIndex({ createdAt: 1 });
    const result = await dropOutcomeTtl(collection(), { dryRun: false });
    expect(result.dropped).toBeNull();
    expect(await indexNames()).toContain('createdAt_1');
  });

  it('dry run changes nothing and reports the collection summary', async () => {
    await seed();
    const before = await collection().indexes();
    const result = await dropOutcomeTtl(collection(), { dryRun: true });
    expect(result.dropped).toBeNull();
    expect(await collection().indexes()).toEqual(before);
    expect(result.summary?.total).toBe(2);
    expect(result.summary?.groups.source).toEqual({ composite: 1, llm: 1 });
    expect(result.summary?.oldestCreatedAt).toBe('2025-10-01T00:00:00.000Z');
  });
});
