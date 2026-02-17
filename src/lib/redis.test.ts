// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockSet = vi.fn();

vi.mock('ioredis', () => {
  const RedisMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.get = mockGet;
    this.set = mockSet;
    this.on = vi.fn().mockReturnThis();
  });
  return { default: RedisMock };
});

beforeEach(() => {
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.resetModules();
  mockGet.mockReset();
  mockSet.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function importModule() {
  return import('./redis');
}

describe('redis client', () => {
  it('returns null when REDIS_URL is missing', async () => {
    vi.stubEnv('REDIS_URL', '');
    const { redis } = await importModule();
    expect(redis).toBeNull();
  });

  it('returns null for ioRedisClient when REDIS_URL is missing', async () => {
    vi.stubEnv('REDIS_URL', '');
    const { ioRedisClient } = await importModule();
    expect(ioRedisClient).toBeNull();
  });

  it('creates redis wrapper when REDIS_URL is set', async () => {
    const { redis } = await importModule();
    expect(redis).not.toBeNull();
    expect(redis).toHaveProperty('get');
    expect(redis).toHaveProperty('set');
  });
});

describe('cachedFetch', () => {
  it('returns cached data on hit without calling fetcher', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ price: 100 }));
    const { cachedFetch } = await importModule();

    const fetcher = vi.fn();
    const result = await cachedFetch('key', fetcher, 60);

    expect(result).toEqual({ price: 100 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('calls fetcher on cache miss and stores result', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');
    const { cachedFetch } = await importModule();

    const fetcher = vi.fn().mockResolvedValue({ price: 200 });
    const result = await cachedFetch('key', fetcher, 120);

    expect(result).toEqual({ price: 200 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith('key', JSON.stringify({ price: 200 }), 'EX', 120);
  });

  it('calls fetcher directly when redis is null', async () => {
    vi.stubEnv('REDIS_URL', '');
    const { cachedFetch } = await importModule();

    const fetcher = vi.fn().mockResolvedValue({ price: 300 });
    const result = await cachedFetch('key', fetcher, 60);

    expect(result).toEqual({ price: 300 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('falls through to fetcher when redis.get() throws', async () => {
    mockGet.mockRejectedValue(new Error('connection refused'));
    mockSet.mockResolvedValue('OK');
    const { cachedFetch } = await importModule();

    const fetcher = vi.fn().mockResolvedValue({ price: 400 });
    const result = await cachedFetch('key', fetcher, 60);

    expect(result).toEqual({ price: 400 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns data even when redis.set() throws', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockRejectedValue(new Error('write failed'));
    const { cachedFetch } = await importModule();

    const fetcher = vi.fn().mockResolvedValue({ price: 500 });
    const result = await cachedFetch('key', fetcher, 60);

    expect(result).toEqual({ price: 500 });
  });

  it('JSON-serializes data when storing', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');
    const { cachedFetch } = await importModule();

    const data = { items: [1, 2, 3] };
    const fetcher = vi.fn().mockResolvedValue(data);
    await cachedFetch('key', fetcher, 60);

    const setCallArg = mockSet.mock.calls[0][1];
    expect(typeof setCallArg).toBe('string');
    expect(JSON.parse(setCallArg as string)).toEqual(data);
  });
});
