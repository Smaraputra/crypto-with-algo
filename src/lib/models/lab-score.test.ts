// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import {
  LabScore,
  insertLabScoreOnce,
  type LabScoreFields,
} from './lab-score';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await LabScore.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  // Delete documents, not the database: dropping it also drops the unique index that init() built once,
  // and the write-once tests would then race without it.
  await LabScore.deleteMany({});
});

function makeScoreFields(overrides: Partial<LabScoreFields> = {}): LabScoreFields {
  return {
    version: 'lab-v1',
    hypothesis: 'L2-15m',
    barClose: 1_700_000_000_000,
    gradedAt: new Date(1_700_000_900_000),
    n: 10,
    x: 0.05,
    b: 0.02,
    turnover: 0.1,
    kN: 1.149,
    s: 0.015,
    sHat: 0.014,
    lambda: 0.2,
    lambda0: 0.3,
    bet: true,
    noBetReason: null,
    weights: { BTCUSDT: 0.2, ETHUSDT: -0.2 },
    netBookReturn: 0.003,
    prices: {
      BTCUSDT: { start: 50_000, end: 50_100 },
      ETHUSDT: { start: 3_000, end: 2_990 },
    },
    state: {
      logE: 0.1,
      logE0: 0.15,
      n: 5,
      sumD: 0.15,
      sumD2: 0.03,
      sumX: 0.25,
      sumX2: 0.05,
      crossedAt: null,
    },
    ...overrides,
  };
}

describe('LabScore model and insertLabScoreOnce', () => {
  it('inserts a valid row with insertLabScoreOnce and reads back every field', async () => {
    const fields = makeScoreFields();
    const res = await insertLabScoreOnce(fields);
    expect(res).toEqual({ inserted: true });

    const stored = await LabScore.findOne({
      version: fields.version,
      hypothesis: fields.hypothesis,
      barClose: fields.barClose,
    }).lean();

    expect(stored).not.toBeNull();
    expect(stored!.version).toBe(fields.version);
    expect(stored!.hypothesis).toBe(fields.hypothesis);
    expect(stored!.barClose).toBe(fields.barClose);
    expect(stored!.gradedAt.getTime()).toBe(fields.gradedAt.getTime());
    expect(stored!.n).toBe(fields.n);
    expect(stored!.x).toBe(fields.x);
    expect(stored!.b).toBe(fields.b);
    expect(stored!.turnover).toBe(fields.turnover);
    expect(stored!.kN).toBe(fields.kN);
    expect(stored!.s).toBe(fields.s);
    expect(stored!.sHat).toBe(fields.sHat);
    expect(stored!.lambda).toBe(fields.lambda);
    expect(stored!.lambda0).toBe(fields.lambda0);
    expect(stored!.bet).toBe(fields.bet);
    expect(stored!.noBetReason).toBeNull();
    expect(stored!.weights).toEqual(fields.weights);
    expect(stored!.netBookReturn).toBe(fields.netBookReturn);
    expect(stored!.prices).toEqual(fields.prices);
    expect(stored!.state).toEqual(fields.state);
    expect(stored!.createdAt).toBeInstanceOf(Date);
  });

  it('does not overwrite on second insert with the same key and returns inserted false', async () => {
    const first = makeScoreFields({ x: 0.05, b: 0.02 });
    const res1 = await insertLabScoreOnce(first);
    expect(res1).toEqual({ inserted: true });

    const second = makeScoreFields({ x: 0.99, b: 0.88 });
    const res2 = await insertLabScoreOnce(second);
    expect(res2).toEqual({ inserted: false });

    const stored = await LabScore.findOne({
      version: first.version,
      hypothesis: first.hypothesis,
      barClose: first.barClose,
    }).lean();

    expect(stored!.x).toBe(first.x);
    expect(stored!.b).toBe(first.b);
  });

  it('handles concurrent inserts of the same key cleanly: exactly one document and one reports inserted true', async () => {
    const data1 = makeScoreFields({ x: 0.01 });
    const data2 = makeScoreFields({ x: 0.02 });

    const [res1, res2] = await Promise.all([
      insertLabScoreOnce(data1),
      insertLabScoreOnce(data2),
    ]);

    const insertedCount = (res1.inserted ? 1 : 0) + (res2.inserted ? 1 : 0);
    expect(insertedCount).toBe(1);

    const total = await LabScore.countDocuments({
      version: data1.version,
      hypothesis: data1.hypothesis,
      barClose: data1.barClose,
    });
    expect(total).toBe(1);
  });

  it('inserts a second row when hypothesis or barClose differs', async () => {
    const base = makeScoreFields();
    const res1 = await insertLabScoreOnce(base);
    expect(res1.inserted).toBe(true);

    const diffHypo = makeScoreFields({ hypothesis: 'L2-1h' });
    const res2 = await insertLabScoreOnce(diffHypo);
    expect(res2.inserted).toBe(true);

    const diffBar = makeScoreFields({ barClose: base.barClose + 900_000 });
    const res3 = await insertLabScoreOnce(diffBar);
    expect(res3.inserted).toBe(true);

    expect(await LabScore.countDocuments()).toBe(3);
  });

  it('rejects an unknown version on create', async () => {
    const invalid = makeScoreFields({ version: 'lab-v2' as unknown as 'lab-v1' });
    await expect(LabScore.create(invalid)).rejects.toThrow();
  });

  it('insertLabScoreOnce validates before its upsert and stores nothing invalid', async () => {
    const badVersion = makeScoreFields({ version: 'lab-v2' as unknown as 'lab-v1' });
    await expect(insertLabScoreOnce(badVersion)).rejects.toThrow();
    const badReason = makeScoreFields({ noBetReason: 'bogus' as unknown as 'late' });
    await expect(insertLabScoreOnce(badReason)).rejects.toThrow();
    expect(await LabScore.countDocuments({})).toBe(0);
  });

  it('round-trips null noBetReason and state with crossedAt null, and rejects unknown noBetReason', async () => {
    const fields = makeScoreFields({
      noBetReason: null,
      weights: null,
      x: null,
      b: null,
      state: {
        logE: 0,
        logE0: 0,
        n: 0,
        sumD: 0,
        sumD2: 0,
        sumX: 0,
        sumX2: 0,
        crossedAt: null,
      },
    });

    const res = await insertLabScoreOnce(fields);
    expect(res.inserted).toBe(true);

    const stored = await LabScore.findOne({
      version: fields.version,
      hypothesis: fields.hypothesis,
      barClose: fields.barClose,
    }).lean();

    expect(stored!.noBetReason).toBeNull();
    expect(stored!.weights).toBeNull();
    expect(stored!.x).toBeNull();
    expect(stored!.b).toBeNull();
    expect(stored!.state.crossedAt).toBeNull();

    // Rejects unknown noBetReason
    const invalid = makeScoreFields({
      barClose: fields.barClose + 900_000,
      noBetReason: 'not_a_valid_reason' as unknown as 'late',
    });
    await expect(LabScore.create(invalid)).rejects.toThrow();
  });
});
