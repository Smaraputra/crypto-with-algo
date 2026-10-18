// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { setRvValidation } from './set-rv-validation';

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
  return mongoose.connection.db!.collection('rvbooks');
}

const SEEDED_DATE = new Date('2026-10-15T00:00:00Z');
const noopLog = () => {};

async function seed() {
  const c = collection();
  await c.insertMany([
    {
      bookName: 'rv-v1',
      version: 'rv-v1',
      validationStatus: 'unvalidated',
      validationRef: null,
      equity: { taker: 10000, maker: 10000 },
      updatedAt: SEEDED_DATE,
    },
    {
      bookName: 'other',
      validationStatus: 'unvalidated',
      validationRef: null,
    },
  ]);
}

describe('setRvValidation', () => {
  it('dry run reports the change and writes nothing', async () => {
    await seed();
    const beforeDoc = await collection().findOne({ bookName: 'rv-v1' });
    const result = await setRvValidation(
      collection(),
      { status: 'rejected', ref: 'R', dryRun: true, bookName: 'rv-v1' },
      noopLog
    );

    expect(result.changed).toBe(true);
    expect(result.after).toEqual({ validationStatus: 'rejected', validationRef: 'R' });
    const stored = await collection().findOne({ bookName: 'rv-v1' });
    expect(stored).toEqual(beforeDoc);
  });

  it('sets status and ref and leaves every other field alone', async () => {
    await seed();
    const result = await setRvValidation(
      collection(),
      { status: 'rejected', ref: 'R', dryRun: false, bookName: 'rv-v1' },
      noopLog
    );

    expect(result.changed).toBe(true);
    const stored = await collection().findOne({ bookName: 'rv-v1' });
    expect(stored?.validationStatus).toBe('rejected');
    expect(stored?.validationRef).toBe('R');
    expect(stored?.equity).toEqual({ taker: 10000, maker: 10000 });
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(SEEDED_DATE.getTime());

    const other = await collection().findOne({ bookName: 'other' });
    expect(other?.validationStatus).toBe('unvalidated');
    expect(other?.validationRef).toBeNull();
  });

  it('is a no-op when the book already carries the verdict', async () => {
    await seed();
    const args = { status: 'rejected' as const, ref: 'R', dryRun: false, bookName: 'rv-v1' };
    const first = await setRvValidation(collection(), args, noopLog);
    expect(first.changed).toBe(true);
    const storedAfterFirst = await collection().findOne({ bookName: 'rv-v1' });

    const second = await setRvValidation(collection(), args, noopLog);
    expect(second.changed).toBe(false);
    const storedAfterSecond = await collection().findOne({ bookName: 'rv-v1' });
    expect(storedAfterSecond?.updatedAt).toEqual(storedAfterFirst?.updatedAt);
  });

  it('throws when the book does not exist and never upserts', async () => {
    await seed();
    await expect(
      setRvValidation(
        collection(),
        { status: 'rejected', ref: 'R', dryRun: false, bookName: 'missing' },
        noopLog
      )
    ).rejects.toThrow('no book named missing');
    expect(await collection().countDocuments({ bookName: 'missing' })).toBe(0);
  });
});
