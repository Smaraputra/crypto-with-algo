/**
 * Crypto news from publisher RSS feeds.
 *
 * Replaces CryptoPanic, whose free Developer plan was discontinued: the
 * /api/developer/v2/ path now returns a 404 HTML page and the remaining plan
 * segments are paid. These feeds need no credentials.
 *
 * Only fetching and normalisation live here. Sentiment scoring stays in
 * news-sentiment.ts, which works from titles, so no provider-supplied
 * sentiment is required.
 */
import { XMLParser } from 'fast-xml-parser';
import type { CryptoNewsItem } from '@/types/news';

export interface NewsFeed {
  source: string;
  url: string;
}

/**
 * Every feed must be reachable from the production VPS, not just locally.
 * CryptoSlate was dropped because it returns 403 to the Contabo IP range
 * regardless of user agent. CoinDesk uses its canonical URL; the trailing-slash
 * form answers with a 308.
 */
export const NEWS_FEEDS: NewsFeed[] = [
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss' },
  { source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { source: 'Decrypt', url: 'https://decrypt.co/feed' },
  { source: 'The Block', url: 'https://www.theblock.co/rss.xml' },
];

const FETCH_TIMEOUT_MS = 8000;

/**
 * Ticker to the words a headline is likely to use. RSS carries no per-currency
 * tags, so symbol relevance has to be matched from the text.
 */
const TICKER_TERMS: Record<string, string[]> = {
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ether', 'ethereum'],
  BNB: ['bnb', 'binance coin'],
  SOL: ['sol', 'solana'],
  XRP: ['xrp', 'ripple'],
  ADA: ['ada', 'cardano'],
  DOGE: ['doge', 'dogecoin'],
  DOT: ['dot', 'polkadot'],
  AVAX: ['avax', 'avalanche'],
  LINK: ['link', 'chainlink'],
  MATIC: ['matic', 'polygon'],
  LTC: ['ltc', 'litecoin'],
  TRX: ['trx', 'tron'],
};

interface RssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  description?: unknown;
  pubDate?: unknown;
  category?: unknown;
}

/** fast-xml-parser yields a bare value, an object with #text, or an array. */
function firstText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return firstText(value[0]);
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    return text == null ? '' : String(text);
  }
  return String(value);
}

function allText(value: unknown): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(firstText).filter((entry) => entry.length > 0);
}

/** RSS descriptions carry marked-up summaries; sentiment and UI both want prose. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseFeed(xml: string, source: string): CryptoNewsItem[] {
  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    // Publishers wrap links and descriptions in CDATA; keep it as text.
    processEntities: false,
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const channel = (parsed as { rss?: { channel?: unknown } })?.rss?.channel;
  const rawItems = (channel as { item?: unknown })?.item;
  if (!rawItems) return [];

  const items: RssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.reduce<CryptoNewsItem[]>((acc, item) => {
    const title = firstText(item.title);
    if (!title) return acc;

    const url = firstText(item.link) || firstText(item.guid);
    const published = Date.parse(firstText(item.pubDate));

    acc.push({
      // Publishers reuse the link as a stable identifier; fall back to the title.
      id: url || title,
      title,
      url,
      source,
      body: stripHtml(firstText(item.description)),
      categories: allText(item.category).join(','),
      // Seconds, matching the shape the UI and snapshot ingestion already read.
      publishedOn: Number.isNaN(published) ? 0 : Math.floor(published / 1000),
      imageUrl: null,
    });
    return acc;
  }, []);
}

/** Fetch and normalise every feed. A failing publisher is skipped, not fatal. */
export async function fetchAllFeeds(): Promise<CryptoNewsItem[]> {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      if (!res.ok) {
        throw new Error(`${feed.source} returned ${res.status}`);
      }
      return parseFeed(await res.text(), feed.source);
    })
  );

  const items: CryptoNewsItem[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      console.error(
        `News feed ${NEWS_FEEDS[i].source} failed:`,
        result.reason instanceof Error ? result.reason.message : 'Unknown error'
      );
    }
  }

  return dedupeAndSort(items);
}

export function dedupeAndSort(items: CryptoNewsItem[]): CryptoNewsItem[] {
  const seen = new Map<string, CryptoNewsItem>();
  for (const item of items) {
    // Syndicated stories appear in several feeds; keep the first occurrence.
    if (!seen.has(item.id)) {
      seen.set(item.id, item);
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.publishedOn - a.publishedOn);
}

/**
 * Keep only stories mentioning the given tickers. `currencies` is the
 * comma-separated form CryptoPanic accepted, so callers are unchanged.
 * An unknown ticker still matches on its own symbol.
 */
export function filterByCurrencies(
  items: CryptoNewsItem[],
  currencies: string
): CryptoNewsItem[] {
  const tickers = currencies
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);

  if (tickers.length === 0) return items;

  const terms = tickers.flatMap(
    (ticker) => TICKER_TERMS[ticker] ?? [ticker.toLowerCase()]
  );

  return items.filter((item) => {
    const haystack = `${item.title} ${item.body} ${item.categories}`.toLowerCase();
    // Word-boundary match so "dot" does not fire on "dotcom" or "link" on "linked".
    return terms.some((term) =>
      new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`).test(haystack)
    );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
