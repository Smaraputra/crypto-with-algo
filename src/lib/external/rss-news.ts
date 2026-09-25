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
import { NEWS_FEEDS } from './news-feeds';
import type { CryptoNewsItem } from '@/types/news';

// The feed list lives in news-feeds.ts, which has no dependencies, so the UI
// can name its sources without pulling fast-xml-parser into the client bundle.
// Re-exported here because every existing caller imports it from this module.
export { NEWS_FEEDS, type NewsFeedSource } from './news-feeds';

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

/**
 * How far back a headline may be published and still count as current news.
 *
 * Shared so the snapshot's `newsSentiment` aggregate and the LLM packet's
 * headline list agree on what "recent" means: the two sit side by side in one
 * packet, and they disagreed while only the list was bounded.
 */
export const NEWS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Keep only stories published inside [fromMs, untilMs], newest first.
 *
 * The feeds carry evergreen items (explainer and video posts months old), and
 * `parseFeed` stores an unparseable date as `publishedOn` 0. Both sort to the
 * tail of the merged feed, so any caller that takes the newest N without a
 * lower bound silently pads its sample with them once the recent,
 * symbol-relevant stories run out. Dateless items are dropped rather than
 * treated as very old, because their true age is unknown.
 */
export function filterByWindow<T extends { publishedOn: number }>(
  items: T[],
  fromMs: number,
  untilMs: number
): T[] {
  return items
    .filter((item) => {
      if (item.publishedOn <= 0) return false;
      const publishedAt = item.publishedOn * 1000;
      return publishedAt >= fromMs && publishedAt <= untilMs;
    })
    .sort((a, b) => b.publishedOn - a.publishedOn);
}

/**
 * Words too common to carry any of a headline's identity.
 *
 * Deliberately tiny: this is only here so that two rewrites of one press
 * release are not judged different because one of them says "the".
 */
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'its', 'of',
  'on', 'or', 'the', 'to', 'with',
]);

/**
 * Jaccard similarity above which two headlines are treated as one story.
 *
 * 0.8 collapses a rewrite that changes an article or reorders a clause while
 * leaving two headlines about the same subject alone: "Bitcoin climbs above
 * 70,000 dollars" and "Bitcoin miners report record hashrate" share only
 * "bitcoin" out of nine content words.
 */
const NEAR_DUPLICATE_SIMILARITY = 0.8;

/** Content words of a headline, lowercased, punctuation stripped. */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0 && !TITLE_STOPWORDS.has(word))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * One entry per story, newest first.
 *
 * Two passes, because the two kinds of duplicate are different. The `id` pass
 * catches genuine syndication, where outlets republish the same item under the
 * same link. The similarity pass catches the case the audit measured: one
 * Solana press release rewritten by four outlets supplied 4 of that symbol's 7
 * articles and was the entire reason its sentiment sat at 0.129, just under
 * the gate. Each rewrite has its own URL, so a URL-keyed dedupe counted four
 * independent observations of what was one.
 *
 * Quadratic in the surviving count, which is bounded by the fetch limit
 * (100 items per cycle), so the comparison is cheap in absolute terms.
 */
export function dedupeAndSort(items: CryptoNewsItem[]): CryptoNewsItem[] {
  const seen = new Map<string, CryptoNewsItem>();
  for (const item of items) {
    // Syndicated stories appear in several feeds; keep the first occurrence.
    if (!seen.has(item.id)) {
      seen.set(item.id, item);
    }
  }

  const kept: Array<{ item: CryptoNewsItem; tokens: Set<string> }> = [];
  for (const item of seen.values()) {
    const tokens = titleTokens(item.title);
    const isRewrite = kept.some(
      (other) => jaccard(tokens, other.tokens) >= NEAR_DUPLICATE_SIMILARITY
    );
    if (!isRewrite) kept.push({ item, tokens });
  }

  return kept.map((entry) => entry.item).sort((a, b) => b.publishedOn - a.publishedOn);
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
