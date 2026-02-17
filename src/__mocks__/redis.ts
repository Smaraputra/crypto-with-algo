export const ioRedisClient = null;
export const redis = null;

export async function cachedFetch<T>(
  _key: string,
  fetcher: () => Promise<T>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ttlSeconds: number
): Promise<T> {
  return fetcher();
}
