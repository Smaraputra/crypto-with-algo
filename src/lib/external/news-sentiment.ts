/**
 * Keyword-based sentiment scoring for news headlines.
 *
 * Pure functions: fetching lives in crypto-news.ts (Redis-cached, timeout).
 * The parameter is widened to anything with a title so both CryptoNewsItem
 * and raw headline lists work.
 */

const BULLISH_KEYWORDS = [
  'rally', 'surge', 'gain', 'rise', 'bull', 'breakout', 'adoption',
  'institutional', 'etf approved', 'upgrade', 'partnership', 'launch',
];

const BEARISH_KEYWORDS = [
  'crash', 'fall', 'drop', 'decline', 'bear', 'sell-off', 'regulation',
  'ban', 'hack', 'scam', 'fraud', 'lawsuit', 'investigation',
];

export interface NewsSentiment {
  count: number;
  avgSentiment: number; // -1 to +1
  topics: string[];
}

interface Headline {
  title: string;
}

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

export function extractTopics(titles: string[]): string[] {
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

export function analyzeNewsSentiment(news: Headline[]): NewsSentiment {
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
