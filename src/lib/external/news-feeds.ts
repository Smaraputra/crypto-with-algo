/**
 * The publisher feeds the news pipeline reads.
 *
 * A module of its own, with no dependencies, so the UI can name its sources
 * without pulling `rss-news.ts` (and `fast-xml-parser` with it) into the client
 * bundle. It exists because the attribution drifted: the provider moved from
 * CryptoPanic to these feeds and the "Powered by CryptoPanic" footer in
 * NewsFeed.tsx was missed, crediting a service the app no longer calls for
 * months. Both the fetcher and the footer now read this list, so the next
 * provider change cannot leave one of them behind.
 */
export interface NewsFeedSource {
  source: string;
  url: string;
  /** Publisher home page, for attribution links. */
  siteUrl: string;
}

/**
 * Every feed must be reachable from the production VPS, not just locally.
 * CryptoSlate was dropped because it returns 403 to the Contabo IP range
 * regardless of user agent. CoinDesk uses its canonical URL; the trailing-slash
 * form answers with a 308.
 */
export const NEWS_FEEDS: NewsFeedSource[] = [
  {
    source: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss',
    siteUrl: 'https://www.coindesk.com',
  },
  {
    source: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    siteUrl: 'https://cointelegraph.com',
  },
  {
    source: 'Decrypt',
    url: 'https://decrypt.co/feed',
    siteUrl: 'https://decrypt.co',
  },
  {
    source: 'The Block',
    url: 'https://www.theblock.co/rss.xml',
    siteUrl: 'https://www.theblock.co',
  },
];
