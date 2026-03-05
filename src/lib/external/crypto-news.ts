import { cachedFetch } from '@/lib/redis';
import type { CryptoNewsItem } from '@/types/news';

interface CryptoPanicPost {
  id: number;
  title: string;
  published_at: string;
  url: string;
  source: { title: string; domain: string };
  currencies?: Array<{ code: string }>;
}

interface CryptoPanicResponse {
  results: CryptoPanicPost[];
}

const BASE_URL = 'https://cryptopanic.com/api/developer/v2/posts/';
const CACHE_TTL = 300; // 5 minutes

async function fetchRaw(currencies?: string): Promise<CryptoNewsItem[]> {
  const token = process.env.CRYPTOPANIC_API_TOKEN;
  if (!token) {
    throw new Error('CRYPTOPANIC_API_TOKEN is not configured');
  }

  const params = new URLSearchParams({
    auth_token: token,
    public: 'true',
    kind: 'news',
  });
  if (currencies) {
    params.set('currencies', currencies);
  }

  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`CryptoPanic News API returned ${res.status}`);
  }

  const json = (await res.json()) as CryptoPanicResponse;
  const posts = json.results ?? [];

  return posts.slice(0, 20).map((post) => ({
    id: String(post.id),
    title: post.title,
    url: post.url,
    source: post.source.title,
    body: '',
    categories: post.currencies?.map((c) => c.code).join(',') ?? '',
    publishedOn: Math.floor(Date.parse(post.published_at) / 1000),
    imageUrl: null,
  }));
}

export async function fetchCryptoNews(currencies?: string): Promise<CryptoNewsItem[]> {
  const cacheKey = `news:crypto:${currencies || 'all'}`;
  return cachedFetch(cacheKey, () => fetchRaw(currencies), CACHE_TTL);
}
