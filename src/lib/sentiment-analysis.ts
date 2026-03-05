/**
 * Fear & Greed Index from Alternative.me
 */

export interface FearGreedData {
  value: number; // 0-100
  valueClassification: string; // "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"
  timestamp: number;
}

export async function fetchFearGreedIndex(): Promise<FearGreedData | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!res.ok) {
      console.error('Failed to fetch Fear & Greed index:', res.status);
      return null;
    }

    const json = await res.json();
    if (!json.data || json.data.length === 0) {
      return null;
    }

    const latest = json.data[0];
    return {
      value: parseInt(latest.value, 10),
      valueClassification: latest.value_classification,
      timestamp: parseInt(latest.timestamp, 10) * 1000, // Convert to ms
    };
  } catch (error) {
    console.error('Failed to fetch Fear & Greed index:', error);
    return null;
  }
}

/**
 * Simple sentiment scoring for news headlines
 *
 * In production, this would use NLP libraries like sentiment or natural
 * For MVP, we use a simple keyword-based approach
 */

const BULLISH_KEYWORDS = [
  'rally', 'surge', 'gain', 'rise', 'bull', 'breakout', 'adoption',
  'institutional', 'etf approved', 'upgrade', 'partnership', 'launch',
];

const BEARISH_KEYWORDS = [
  'crash', 'fall', 'drop', 'decline', 'bear', 'sell-off', 'regulation',
  'ban', 'hack', 'scam', 'fraud', 'lawsuit', 'investigation',
];

export interface NewsItem {
  title: string;
  url: string;
  publishedAt: number; // Unix timestamp
  source: string;
}

export interface NewsSentiment {
  count: number;
  avgSentiment: number; // -1 to +1
  topics: string[];
}

/**
 * Score a single headline's sentiment
 */
function scoreHeadline(title: string): number {
  const lower = title.toLowerCase();
  let score = 0;

  for (const keyword of BULLISH_KEYWORDS) {
    if (lower.includes(keyword)) {
      score += 0.3;
    }
  }

  for (const keyword of BEARISH_KEYWORDS) {
    if (lower.includes(keyword)) {
      score -= 0.3;
    }
  }

  // Clamp to [-1, 1]
  return Math.max(-1, Math.min(1, score));
}

/**
 * Extract topics from headlines (very simple for MVP)
 */
function extractTopics(titles: string[]): string[] {
  const topicKeywords = {
    'regulation': ['regulation', 'sec', 'government', 'ban', 'law'],
    'institutional': ['institutional', 'etf', 'fund', 'investment'],
    'defi': ['defi', 'decentralized', 'dex', 'yield'],
    'nft': ['nft', 'opensea', 'metaverse'],
    'security': ['hack', 'security', 'breach', 'exploit'],
    'mining': ['mining', 'hashrate', 'difficulty'],
  };

  const found = new Set<string>();

  for (const title of titles) {
    const lower = title.toLowerCase();
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some(kw => lower.includes(kw))) {
        found.add(topic);
      }
    }
  }

  return Array.from(found);
}

/**
 * Analyze sentiment from news items
 */
export function analyzeNewsSentiment(news: NewsItem[]): NewsSentiment {
  if (news.length === 0) {
    return { count: 0, avgSentiment: 0, topics: [] };
  }

  const scores = news.map(item => scoreHeadline(item.title));
  const avgSentiment = scores.reduce((sum, s) => sum + s, 0) / scores.length;

  return {
    count: news.length,
    avgSentiment,
    topics: extractTopics(news.map(n => n.title)),
  };
}

/**
 * Fetch crypto news from CryptoPanic API (free tier)
 */
export async function fetchCryptoNews(symbol: string): Promise<NewsItem[]> {
  try {
    const token = process.env.CRYPTOPANIC_API_TOKEN;
    if (!token) return [];

    // Remove USDT suffix for news queries
    const baseSymbol = symbol.replace(/USDT$/, '');

    const params = new URLSearchParams({
      auth_token: token,
      currencies: baseSymbol,
      kind: 'news',
      public: 'true',
    });
    const res = await fetch(`https://cryptopanic.com/api/developer/v2/posts/?${params.toString()}`);

    if (!res.ok) {
      console.error(`Failed to fetch news for ${symbol}:`, res.status);
      return [];
    }

    const json = await res.json();
    if (!json.results) {
      return [];
    }

    // Return last 10 articles
    return json.results.slice(0, 10).map((item: {
      title: string;
      url?: string;
      published_at: string;
      source?: { title: string };
    }) => ({
      title: item.title,
      url: item.url ?? '',
      publishedAt: Date.parse(item.published_at),
      source: item.source?.title ?? '',
    }));
  } catch (error) {
    console.error(`Failed to fetch news for ${symbol}:`, error);
    return [];
  }
}
