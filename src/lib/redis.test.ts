// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockSet = vi.fn();

vi.mock('@upstash/redis', () => {
  const RedisMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.get = mockGet;
    this.set = mockSet;
  });
  return { Redis: RedisMock };
});

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token');
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
  it('returns null when env vars are missing', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    const { redis } = await importModule();
    expect(redis).toBeNull();
  });
});

describe('cachedFetch', () => {
  it('returns cached data on hit without calling fetcher', async () => {
    mockGet.mockResolvedValue({ price: 100 });
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
    expect(mockSet).toHaveBeenCalledWith('key', { price: 200 }, { ex: 120 });
  });

  it('calls fetcher directly when redis is null', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
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

  it('does not double-stringify data when storing', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');
    const { cachedFetch } = await importModule();

    const data = { items: [1, 2, 3] };
    const fetcher = vi.fn().mockResolvedValue(data);
    await cachedFetch('key', fetcher, 60);

    // Should pass the raw object, not JSON.stringify(data)
    const setCallArg = mockSet.mock.calls[0][1];
    expect(typeof setCallArg).toBe('object');
    expect(setCallArg).toEqual(data);
  });
});
