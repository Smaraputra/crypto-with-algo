import { cachedFetch } from '@/lib/redis';
import type { CryptoNewsItem } from '@/types/news';

interface CryptoCompareNewsResponse {
  Data: Array<{
    id: string;
    title: string;
    url: string;
    source: string;
    body: string;
    categories: string;
    published_on: number;
    imageurl: string;
  }>;
}

const NEWS_URL = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest';
const CACHE_TTL = 300; // 5 minutes

async function fetchRaw(categories?: string): Promise<CryptoNewsItem[]> {
  let url = NEWS_URL;
  if (categories) {
    url += `&categories=${encodeURIComponent(categories)}`;
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`CryptoCompare News API returned ${res.status}`);
  }

  const json = (await res.json()) as CryptoCompareNewsResponse;
  const items = json.Data ?? [];

  return items.slice(0, 20).map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    body: item.body.slice(0, 200),
    categories: item.categories,
    publishedOn: item.published_on,
    imageUrl: item.imageurl || null,
  }));
}

export async function fetchCryptoNews(categories?: string): Promise<CryptoNewsItem[]> {
  const cacheKey = `news:crypto:${categories || 'all'}`;
  return cachedFetch(cacheKey, () => fetchRaw(categories), CACHE_TTL);
}
