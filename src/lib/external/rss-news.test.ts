import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseFeed,
  stripHtml,
  dedupeAndSort,
  filterByCurrencies,
  filterByWindow,
  fetchAllFeeds,
  NEWS_FEEDS,
  NEWS_WINDOW_MS,
} from './rss-news';
import {
  cointelegraphRss,
  decryptRss,
  singleItemRss,
  emptyChannelRss,
} from '@/__fixtures__/news';

describe('stripHtml', () => {
  it('removes tags and decodes the entities RSS summaries carry', () => {
    expect(stripHtml('<p>Institutional demand&nbsp;grew &amp; held</p>')).toBe(
      'Institutional demand grew & held'
    );
  });

  it('drops script and style content rather than exposing its text', () => {
    expect(stripHtml('<script>alert(1)</script><p>Real copy</p>')).toBe('Real copy');
    expect(stripHtml('<style>.a{color:red}</style><p>Real copy</p>')).toBe('Real copy');
  });

  it('collapses whitespace left behind by removed markup', () => {
    expect(stripHtml('<p>one</p>\n\n   <p>two</p>')).toBe('one two');
  });

  it('returns an empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('parseFeed', () => {
  it('normalises items to the CryptoNewsItem shape', () => {
    const items = parseFeed(cointelegraphRss, 'Cointelegraph');

    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      id: 'https://cointelegraph.com/news/btc-etf-inflows?utm_source=rss_feed',
      title: 'Bitcoin ETF inflows surge past record high',
      url: 'https://cointelegraph.com/news/btc-etf-inflows?utm_source=rss_feed',
      source: 'Cointelegraph',
      body: 'Institutional demand for Bitcoin continued to climb.',
      categories: 'Latest News,Bitcoin',
      publishedOn: Math.floor(Date.parse('Wed, 09 Sep 2026 21:30:00 +0000') / 1000),
      imageUrl: null,
    });
  });

  it('strips markup from the description so sentiment scores prose', () => {
    const items = parseFeed(cointelegraphRss, 'Cointelegraph');

    expect(items[0].body).not.toContain('<');
    expect(items[0].body).not.toContain('img');
  });

  it('prefers the CDATA link but falls back to guid', () => {
    const items = parseFeed(cointelegraphRss, 'Cointelegraph');

    expect(items[0].url).toContain('cointelegraph.com/news/btc-etf-inflows');
    expect(items[2].url).toBe('https://cointelegraph.com/news/exchange-hack');
  });

  it('joins repeated category elements', () => {
    const items = parseFeed(cointelegraphRss, 'Cointelegraph');

    expect(items[0].categories).toBe('Latest News,Bitcoin');
    expect(items[2].categories).toBe('');
  });

  it('converts pubDate to epoch seconds', () => {
    const items = parseFeed(cointelegraphRss, 'Cointelegraph');

    // Seconds, not milliseconds: the UI and snapshot ingestion both read seconds.
    expect(items[0].publishedOn).toBeLessThan(2_000_000_000_0);
    expect(items[0].publishedOn).toBeGreaterThan(1_700_000_000);
  });

  it('handles a single-item feed, which RSS emits as an object not an array', () => {
    const items = parseFeed(singleItemRss, 'CoinDesk');

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Cardano adoption grows among institutions');
  });

  it('returns an empty array for a channel with no items', () => {
    expect(parseFeed(emptyChannelRss, 'CoinDesk')).toEqual([]);
  });

  it('returns an empty array rather than throwing on unparseable input', () => {
    expect(parseFeed('not xml at all <<<', 'CoinDesk')).toEqual([]);
    expect(parseFeed('', 'CoinDesk')).toEqual([]);
  });
});

describe('dedupeAndSort', () => {
  it('keeps one copy of a story syndicated across feeds', () => {
    const items = [
      ...parseFeed(cointelegraphRss, 'Cointelegraph'),
      ...parseFeed(decryptRss, 'Decrypt'),
    ];

    const result = dedupeAndSort(items);

    const etfStories = result.filter((item) =>
      item.title === 'Bitcoin ETF inflows surge past record high'
    );
    expect(etfStories).toHaveLength(1);
    // First occurrence wins, so the story keeps its original publisher.
    expect(etfStories[0].source).toBe('Cointelegraph');
  });

  it('collapses one press release rewritten by several outlets', () => {
    // The measured case: one Solana press release supplied 4 of SOL's 7
    // articles and was the whole reason its score sat at 0.129, just under the
    // 0.15 gate. Each outlet gives it its own URL, so a URL-keyed dedupe sees
    // four independent stories and `count` reads four.
    const base = {
      url: '',
      body: '',
      categories: '',
      publishedOn: 1_700_000_000,
      imageUrl: null,
    };
    const items = [
      { ...base, id: 'a', source: 'CoinDesk', title: 'Solana Foundation announces Firedancer mainnet rollout' },
      { ...base, id: 'b', source: 'Decrypt', title: 'Solana Foundation Announces Firedancer Mainnet Rollout' },
      { ...base, id: 'c', source: 'Cointelegraph', title: 'Solana foundation announces the Firedancer mainnet rollout' },
      { ...base, id: 'd', source: 'TheBlock', title: 'Bitcoin ETF inflows hit a record' },
    ];

    const result = dedupeAndSort(items);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.source)).toContain('CoinDesk');
    expect(result.map((item) => item.source)).toContain('TheBlock');
  });

  it('keeps stories that merely share a subject', () => {
    const base = {
      url: '',
      body: '',
      categories: '',
      publishedOn: 1_700_000_000,
      imageUrl: null,
    };

    const result = dedupeAndSort([
      { ...base, id: 'a', source: 'CoinDesk', title: 'Bitcoin climbs above 70,000 dollars' },
      { ...base, id: 'b', source: 'Decrypt', title: 'Bitcoin miners report record hashrate' },
    ]);

    expect(result).toHaveLength(2);
  });

  it('orders newest first', () => {
    const result = dedupeAndSort([
      ...parseFeed(cointelegraphRss, 'Cointelegraph'),
      ...parseFeed(decryptRss, 'Decrypt'),
    ]);

    const times = result.map((item) => item.publishedOn);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('filterByWindow', () => {
  const NOW = 1_700_000_000_000;
  const at = (msAgo: number) => ({ publishedOn: Math.floor((NOW - msAgo) / 1000) });
  const hours = (n: number) => n * 60 * 60 * 1000;
  const days = (n: number) => n * 24 * hours(1);

  it('keeps items inside the window', () => {
    const items = [at(hours(1)), at(days(2))];
    expect(filterByWindow(items, NOW - NEWS_WINDOW_MS, NOW)).toHaveLength(2);
  });

  it('drops items older than the lower bound', () => {
    // The defect this exists to prevent: evergreen posts months old filling the
    // sample once recent stories run out.
    const fresh = at(hours(2));
    const evergreen = at(days(200));

    expect(filterByWindow([fresh, evergreen], NOW - NEWS_WINDOW_MS, NOW)).toEqual([fresh]);
  });

  it('drops items published after the upper bound', () => {
    const future = { publishedOn: Math.floor((NOW + hours(1)) / 1000) };
    expect(filterByWindow([future], NOW - NEWS_WINDOW_MS, NOW)).toEqual([]);
  });

  it('drops dateless items rather than treating them as very old', () => {
    // parseFeed stores an unparseable pubDate as 0, which would otherwise pass
    // an upper-bound-only check and sort to the tail.
    expect(filterByWindow([{ publishedOn: 0 }], 0, NOW)).toEqual([]);
  });

  it('returns survivors newest first regardless of input order', () => {
    const older = at(days(2));
    const newer = at(hours(3));

    const result = filterByWindow([older, newer], NOW - NEWS_WINDOW_MS, NOW);

    expect(result).toEqual([newer, older]);
  });

  it('includes items exactly on either bound', () => {
    const from = NOW - NEWS_WINDOW_MS;
    const onFrom = { publishedOn: Math.floor(from / 1000) };
    const onUntil = { publishedOn: Math.floor(NOW / 1000) };

    expect(filterByWindow([onFrom, onUntil], from, NOW)).toHaveLength(2);
  });

  it('returns an empty array when nothing is recent', () => {
    expect(filterByWindow([at(days(30)), at(days(60))], NOW - NEWS_WINDOW_MS, NOW)).toEqual([]);
  });
});

describe('filterByCurrencies', () => {
  const items = dedupeAndSort([
    ...parseFeed(cointelegraphRss, 'Cointelegraph'),
    ...parseFeed(decryptRss, 'Decrypt'),
  ]);

  it('matches a ticker by its full coin name', () => {
    const result = filterByCurrencies(items, 'BTC');

    expect(result).toHaveLength(1);
    expect(result[0].title).toContain('Bitcoin ETF');
  });

  it('matches on a name variant in the body', () => {
    const result = filterByCurrencies(items, 'ETH');

    expect(result.map((item) => item.title)).toContain('Ethereum upgrade ships on mainnet');
  });

  it('matches an uppercase ticker appearing in the body', () => {
    const result = filterByCurrencies(items, 'SOL');

    expect(result.map((item) => item.title)).toContain('Solana partnership drives a rally');
  });

  it('excludes stories that mention no relevant coin', () => {
    const result = filterByCurrencies(items, 'BTC');

    expect(result.map((item) => item.title)).not.toContain(
      'Regulators open investigation into an exchange hack'
    );
  });

  it('accepts the comma-separated form the previous provider used', () => {
    const result = filterByCurrencies(items, 'BTC,ETH');
    const titles = result.map((item) => item.title);

    expect(titles).toContain('Bitcoin ETF inflows surge past record high');
    expect(titles).toContain('Ethereum upgrade ships on mainnet');
  });

  it('returns everything when no ticker is given', () => {
    expect(filterByCurrencies(items, '')).toHaveLength(items.length);
    expect(filterByCurrencies(items, '  ,  ')).toHaveLength(items.length);
  });

  it('respects word boundaries so short tickers do not match substrings', () => {
    const decoys = [
      {
        id: '1', title: 'A linked list of dotcom era lessons', url: '', source: 'X',
        body: 'Nothing to do with crypto assets.', categories: '', publishedOn: 1, imageUrl: null,
      },
    ];

    expect(filterByCurrencies(decoys, 'DOT')).toHaveLength(0);
    expect(filterByCurrencies(decoys, 'LINK')).toHaveLength(0);
  });

  it('falls back to the bare symbol for a ticker with no name mapping', () => {
    const items = [
      {
        id: '1', title: 'ZZZ token launches', url: '', source: 'X',
        body: '', categories: '', publishedOn: 1, imageUrl: null,
      },
    ];

    expect(filterByCurrencies(items, 'ZZZ')).toHaveLength(1);
  });
});

describe('fetchAllFeeds', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('merges every configured feed', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => singleItemRss });

    const items = await fetchAllFeeds();

    expect(mockFetch).toHaveBeenCalledTimes(NEWS_FEEDS.length);
    // Same fixture from every feed, so dedupe collapses it to one story.
    expect(items).toHaveLength(1);
  });

  it('keeps working when one publisher fails', async () => {
    mockFetch.mockImplementation((url: string) =>
      url === NEWS_FEEDS[0].url
        ? Promise.reject(new Error('ECONNRESET'))
        : Promise.resolve({ ok: true, text: async () => singleItemRss })
    );

    const items = await fetchAllFeeds();

    expect(items).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('skips a publisher returning a non-ok status', async () => {
    mockFetch.mockImplementation((url: string) =>
      url === NEWS_FEEDS[0].url
        ? Promise.resolve({ ok: false, status: 403, text: async () => '' })
        : Promise.resolve({ ok: true, text: async () => singleItemRss })
    );

    const items = await fetchAllFeeds();

    expect(items).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(NEWS_FEEDS[0].source),
      expect.stringContaining('403')
    );
  });

  it('returns an empty list when every publisher fails, rather than throwing', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));

    await expect(fetchAllFeeds()).resolves.toEqual([]);
  });
});
