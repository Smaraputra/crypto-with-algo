// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  globalThis.mongoose = undefined;
  vi.resetModules();
});

afterEach(async () => {
  await mongoose.disconnect();
});

async function loadConnectDB() {
  const mod = await import('./mongodb');
  return mod.connectDB;
}

describe('connectDB', () => {
  it('returns a connection', async () => {
    vi.stubEnv('MONGODB_URI', mongoServer.getUri());
    const connectDB = await loadConnectDB();
    const conn = await connectDB();
    expect(conn.connection.readyState).toBe(1);
    vi.unstubAllEnvs();
  });

  it('returns cached connection on second call', async () => {
    vi.stubEnv('MONGODB_URI', mongoServer.getUri());
    const connectDB = await loadConnectDB();
    const conn1 = await connectDB();
    const conn2 = await connectDB();
    expect(conn1).toBe(conn2);
    vi.unstubAllEnvs();
  });

  it('throws without MONGODB_URI', async () => {
    delete process.env.MONGODB_URI;
    const connectDB = await loadConnectDB();
    await expect(connectDB()).rejects.toThrow('MONGODB_URI environment variable is not defined');
  });

  it('retries after a failed connection', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://invalid:27017/test?connectTimeoutMS=500&serverSelectionTimeoutMS=500');
    const connectDB = await loadConnectDB();
    await expect(connectDB()).rejects.toThrow();

    // After failure, cached.promise should be reset to null, so next call can retry
    process.env.MONGODB_URI = mongoServer.getUri();
    const conn = await connectDB();
    expect(conn.connection.readyState).toBe(1);
    vi.unstubAllEnvs();
  }, 15_000);
});
