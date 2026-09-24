// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { JobHeartbeat } from './job-heartbeat';
import { recordJobRun } from '@/lib/job-run';

// mongoose is connected to the in-memory server below, so the app's own
// connector must not try to dial MONGODB_URI. Left real, it throws,
// recordJobRun's never-throw guard swallows it, and every assertion here would
// pass vacuously against an empty collection.
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  // The unique index is what keeps the collection at one row per job; without
  // syncIndexes it is not built in an in-memory database.
  await JobHeartbeat.syncIndexes();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await JobHeartbeat.deleteMany({});
});

describe('JobHeartbeat', () => {
  it('rejects a job name outside the crontab table', async () => {
    // The enum is derived from CRON_JOBS, so a typo'd key cannot quietly
    // create an eighteenth row that no health check ever looks at.
    await expect(
      JobHeartbeat.create({
        job: 'not-a-real-job',
        lastRunAt: new Date(),
        lastDurationMs: 1,
        lastStatus: 'success',
      })
    ).rejects.toThrow();
  });

  it('keeps one row per job however many times it runs', async () => {
    for (let i = 0; i < 5; i++) {
      await recordJobRun('sync-candles:1m', { ok: true, durationMs: i, result: { synced: i } });
    }

    expect(await JobHeartbeat.countDocuments({})).toBe(1);
    const doc = await JobHeartbeat.findOne({ job: 'sync-candles:1m' });
    expect(doc!.runCount).toBe(5);
    expect(doc!.lastResult).toEqual({ synced: 4 });
  });

  it('refuses a duplicate row for the same job', async () => {
    await JobHeartbeat.create({
      job: 'resolve-outcomes',
      lastRunAt: new Date(),
      lastDurationMs: 1,
      lastStatus: 'success',
    });

    await expect(
      JobHeartbeat.create({
        job: 'resolve-outcomes',
        lastRunAt: new Date(),
        lastDurationMs: 1,
        lastStatus: 'success',
      })
    ).rejects.toThrow();
  });
});

describe('recordJobRun against a real collection', () => {
  it('creates the row on the first run', async () => {
    await recordJobRun('ingest-perp', { ok: true, durationMs: 120, result: { written: 8352 } });

    const doc = await JobHeartbeat.findOne({ job: 'ingest-perp' });
    expect(doc).not.toBeNull();
    expect(doc!.lastStatus).toBe('success');
    expect(doc!.lastSuccessAt).toBeInstanceOf(Date);
    expect(doc!.lastFailureAt).toBeNull();
    expect(doc!.consecutiveFailures).toBe(0);
    expect(doc!.runCount).toBe(1);
  });

  it('counts consecutive failures and resets them on the next success', async () => {
    await recordJobRun('ingest-archive', { ok: false, durationMs: 5, error: 'archive 500' });
    await recordJobRun('ingest-archive', { ok: false, durationMs: 5, error: 'archive 500' });

    let doc = await JobHeartbeat.findOne({ job: 'ingest-archive' });
    expect(doc!.consecutiveFailures).toBe(2);
    expect(doc!.failureCount).toBe(2);
    expect(doc!.lastStatus).toBe('failure');

    await recordJobRun('ingest-archive', { ok: true, durationMs: 5, result: { written: 1 } });

    doc = await JobHeartbeat.findOne({ job: 'ingest-archive' });
    expect(doc!.consecutiveFailures).toBe(0);
    expect(doc!.failureCount).toBe(2);
    expect(doc!.runCount).toBe(3);
    expect(doc!.lastStatus).toBe('success');
  });

  it('keeps the last error after a later success', async () => {
    // A success must not erase the evidence of the failure before it: that
    // history is the only record of an intermittent job.
    await recordJobRun('check-alerts', { ok: false, durationMs: 1, error: 'mongo timeout' });
    await recordJobRun('check-alerts', { ok: true, durationMs: 1 });

    const doc = await JobHeartbeat.findOne({ job: 'check-alerts' });
    expect(doc!.lastError).toBe('mongo timeout');
    expect(doc!.lastFailureAt).toBeInstanceOf(Date);
    expect(doc!.lastStatus).toBe('success');
  });

  it('swallows a write for an unknown job rather than throwing at the caller', async () => {
    // recordJobRun must never be able to fail a live cron route, even when the
    // enum rejects the key.
    await expect(
      recordJobRun('bogus-job', { ok: true, durationMs: 1 })
    ).resolves.toBeUndefined();

    expect(await JobHeartbeat.countDocuments({})).toBe(0);
  });
});
