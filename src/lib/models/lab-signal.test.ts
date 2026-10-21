// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import {
  LabSignal,
  insertLabSignalOnce,
  type LabSignalFields,
} from './lab-signal';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await LabSignal.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  // Delete documents, not the database: dropping it also drops the unique index that init() built once,
  // and the write-once tests would then race without it.
  await LabSignal.deleteMany({});
});

function makeSignalFields(overrides: Partial<LabSignalFields> = {}): LabSignalFields {
  return {
    version: 'lab-v1',
    hypothesis: 'L2-15m',
    candidate: 'L2',
    timeframe: '15m',
    barClose: 1_700_000_000_000,
    writtenAt: new Date(1_700_000_005_000),
    late: false,
    scores: {},
    skipped: [],
    inputs: {},
    ...overrides,
  };
}

describe('LabSignal model and insertLabSignalOnce', () => {
  it('inserts a valid row with insertLabSignalOnce and reads back every field including empty scores and inputs', async () => {
    const fields = makeSignalFields({
      scores: {},
      inputs: {},
      skipped: [{ symbol: 'BTCUSDT', reason: 'rv_skipped' }],
    });
    const res = await insertLabSignalOnce(fields);
    expect(res).toEqual({ inserted: true });

    const stored = await LabSignal.findOne({
      version: fields.version,
      hypothesis: fields.hypothesis,
      barClose: fields.barClose,
    }).lean();

    expect(stored).not.toBeNull();
    expect(stored!.version).toBe(fields.version);
    expect(stored!.hypothesis).toBe(fields.hypothesis);
    expect(stored!.candidate).toBe(fields.candidate);
    expect(stored!.timeframe).toBe(fields.timeframe);
    expect(stored!.barClose).toBe(fields.barClose);
    expect(stored!.writtenAt.getTime()).toBe(fields.writtenAt.getTime());
    expect(stored!.late).toBe(fields.late);
    expect(stored!.scores).toEqual({});
    expect(stored!.inputs).toEqual({});
    expect(stored!.skipped).toEqual([{ symbol: 'BTCUSDT', reason: 'rv_skipped' }]);
    expect(stored!.createdAt).toBeInstanceOf(Date);
  });

  it('does not overwrite on second insert with the same key and returns inserted false', async () => {
    const first = makeSignalFields({ scores: { BTCUSDT: 1.5 }, late: false });
    const res1 = await insertLabSignalOnce(first);
    expect(res1).toEqual({ inserted: true });

    const second = makeSignalFields({ scores: { BTCUSDT: -2.0, ETHUSDT: 0.5 }, late: true });
    const res2 = await insertLabSignalOnce(second);
    expect(res2).toEqual({ inserted: false });

    const stored = await LabSignal.findOne({
      version: first.version,
      hypothesis: first.hypothesis,
      barClose: first.barClose,
    }).lean();

    expect(stored!.scores).toEqual(first.scores);
    expect(stored!.late).toBe(first.late);
  });

  it('handles concurrent inserts of the same key cleanly: exactly one document and one reports inserted true', async () => {
    const data1 = makeSignalFields({ scores: { BTCUSDT: 1 } });
    const data2 = makeSignalFields({ scores: { BTCUSDT: 2 } });

    const [res1, res2] = await Promise.all([
      insertLabSignalOnce(data1),
      insertLabSignalOnce(data2),
    ]);

    const insertedCount = (res1.inserted ? 1 : 0) + (res2.inserted ? 1 : 0);
    expect(insertedCount).toBe(1);

    const total = await LabSignal.countDocuments({
      version: data1.version,
      hypothesis: data1.hypothesis,
      barClose: data1.barClose,
    });
    expect(total).toBe(1);
  });

  it('inserts a second row when hypothesis or barClose differs', async () => {
    const base = makeSignalFields();
    const res1 = await insertLabSignalOnce(base);
    expect(res1.inserted).toBe(true);

    const diffHypo = makeSignalFields({ hypothesis: 'L2-1h', timeframe: '1h' });
    const res2 = await insertLabSignalOnce(diffHypo);
    expect(res2.inserted).toBe(true);

    const diffBar = makeSignalFields({ barClose: base.barClose + 900_000 });
    const res3 = await insertLabSignalOnce(diffBar);
    expect(res3.inserted).toBe(true);

    expect(await LabSignal.countDocuments()).toBe(3);
  });

  it('rejects an unknown version on create', async () => {
    const invalid = makeSignalFields({ version: 'lab-v99' as unknown as 'lab-v1' });
    await expect(LabSignal.create(invalid)).rejects.toThrow();
  });

  it('rejects an unknown skip reason on create', async () => {
    const invalid = makeSignalFields({
      skipped: [{ symbol: 'BTCUSDT', reason: 'unknown_reason' as unknown as 'rv_skipped' }],
    });
    await expect(LabSignal.create(invalid)).rejects.toThrow();
  });

  it('insertLabSignalOnce validates before its upsert and stores nothing invalid', async () => {
    const badReason = makeSignalFields({
      skipped: [{ symbol: 'BTCUSDT', reason: 'unknown_reason' as unknown as 'rv_skipped' }],
    });
    await expect(insertLabSignalOnce(badReason)).rejects.toThrow();
    const badVersion = makeSignalFields({ version: 'lab-v99' as unknown as 'lab-v1' });
    await expect(insertLabSignalOnce(badVersion)).rejects.toThrow();
    expect(await LabSignal.countDocuments({})).toBe(0);
  });
});
