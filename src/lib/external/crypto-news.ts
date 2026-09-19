/**
 * Crypto news, cached.
 *
 * This is the single seam every caller uses. The provider behind it changed
 * from CryptoPanic (free plan discontinued) to publisher RSS feeds; the
 * signature is unchanged so snapshot ingestion, the news API route, and the
 * NewsFeed component were untouched by that swap.
 */
import { cachedFetch } from '@/lib/redis';
import { fetchAllFeeds, filterByCurrencies } from '@/lib/external/rss-news';
import type { CryptoNewsItem } from '@/types/news';

const CACHE_KEY = 'news:crypto:all';
const CACHE_TTL = 300; // 5 minutes
const MAX_ITEMS = 20;

/**
 * Latest crypto news, optionally narrowed to a comma-separated ticker list.
 *
 * The merged feed set is cached once and filtered in memory. Snapshot ingestion
 * asks for ten symbols per cycle, which previously meant ten upstream calls per
 * cycle against a per-symbol cache key.
 */
export async function fetchCryptoNews(currencies?: string, limit: number = MAX_ITEMS): Promise<CryptoNewsItem[]> {
  const all = await cachedFetch(CACHE_KEY, fetchAllFeeds, CACHE_TTL);
  const relevant = currencies ? filterByCurrencies(all, currencies) : all;
  return relevant.slice(0, limit);
}
