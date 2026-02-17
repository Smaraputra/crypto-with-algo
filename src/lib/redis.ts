import Redis from 'ioredis';

function createRedisClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 3) return null; // stop retrying
      return Math.min(times * 200, 2000);
    },
  });

  client.on('error', (err) => {
    console.error('Redis connection error:', err.message);
  });

  return client;
}

/** Raw ioredis client -- used by rate-limit.ts for Lua scripts */
export const ioRedisClient = createRedisClient();

/** Wrapper with Upstash-compatible get/set API for direct consumers */
export const redis = ioRedisClient
  ? {
      async get(key: string): Promise<string | null> {
        return ioRedisClient.get(key);
      },
      async set(
        key: string,
        value: string | number,
        options?: { ex?: number }
      ): Promise<void> {
        const str = typeof value === 'string' ? value : String(value);
        if (options?.ex) {
          await ioRedisClient.set(key, str, 'EX', options.ex);
        } else {
          await ioRedisClient.set(key, str);
        }
      },
    }
  : null;

export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number
): Promise<T> {
  if (!redis) {
    return fetcher();
  }

  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch {
    // Redis get or JSON parse failed, fall through to fetcher
  }

  const data = await fetcher();

  try {
    await redis.set(key, JSON.stringify(data), { ex: ttlSeconds });
  } catch {
    // Redis set failed, data still returned
  }

  return data;
}
