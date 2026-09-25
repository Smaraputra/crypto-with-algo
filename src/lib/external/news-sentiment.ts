/**
 * Keyword sentiment scoring for news items.
 *
 * Pure functions: fetching lives in crypto-news.ts (Redis-cached, timeout).
 *
 * The 2026-09-25 audit measured what this produced and found it lexically
 * broken in three ways. All three are fixed here; the scale and the scorer's
 * `>= 0.15` gate are deliberately unchanged, because a gate calibrated against
 * a noisy input must not be loosened at the same time the input is cleaned.
 *
 * 1. MATCHING WAS SUBSTRING. `includes('ban')` fired on bank, banking,
 *    interbank, urban, Albania, bands and banner, so an institutional
 *    bank-adoption headline scored BEARISH; `gain` fired on "again" and `rise`
 *    on "surprise". Matching is now anchored on non-alphanumeric boundaries,
 *    the same rule `filterByCurrencies` already used to pick the articles.
 * 2. THE LIST WAS UNSTEMMED, so `rally` missed "rallies" and "rallied" and
 *    `hack` missed "hacked". Each keyword now carries its regular inflections.
 * 3. SELECTION AND SCORING DISAGREED. Articles are selected on title, body and
 *    categories; 35% of attributed articles had titles that never named their
 *    symbol, and the body that won them their place was never read. The body
 *    is now scored at a lower weight than the title.
 *
 * Distinct keywords, not occurrences: a press release repeating "rally" forty
 * times is one piece of evidence, and counting occurrences would let any long
 * body saturate the clamp on a single word.
 */

const BULLISH_KEYWORDS = [
  'rally', 'surge', 'gain', 'rise', 'bull', 'breakout', 'adoption',
  'institutional', 'etf approved', 'upgrade', 'partnership', 'launch',
];

const BEARISH_KEYWORDS = [
  'crash', 'fall', 'drop', 'decline', 'bear', 'sell-off', 'regulation',
  'ban', 'hack', 'scam', 'fraud', 'lawsuit', 'investigation',
];

/** Score contributed by one distinct keyword found in the title. */
const KEYWORD_WEIGHT = 0.3;

/**
 * The body's share of that weight.
 *
 * Below one because a headline is written to characterise the story while a
 * body mentions many things in passing, and because the gate this feeds was
 * calibrated on title-only scores: a body at equal weight would roughly double
 * typical magnitudes and let articles through a threshold that had not moved.
 */
const BODY_WEIGHT_FACTOR = 0.4;

/**
 * Regular English inflections, as a regex suffix group.
 *
 * A real stemmer is not worth a dependency here: the keyword list is thirteen
 * words per direction and every one of them is regular apart from the `y` and
 * silent-`e` endings, which are handled separately. `ish` is included because
 * "bullish" and "bearish" are the commonest forms of two of the keywords in
 * crypto headlines, and the unstemmed list missed both.
 */
const REGULAR_SUFFIXES = '(?:s|es|ed|ing|ish)?';
const Y_SUFFIXES = '(?:y|ies|ied|ying)';
/** A stem ending in silent `e` drops it before a vowel: decline -> declining. */
const E_SUFFIXES = '(?:e|es|ed|ing|ish)';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One keyword as a boundary-anchored, inflection-tolerant pattern.
 *
 * Only the last word of a multi-word keyword ("etf approved") takes the
 * suffix group, since that is the one that inflects.
 */
function keywordPattern(keyword: string): RegExp {
  const words = keyword.split(' ');
  const last = words[words.length - 1];
  const head = words.slice(0, -1).map(escapeRegExp);

  let stem: string;
  if (last.endsWith('y')) {
    stem = `${escapeRegExp(last.slice(0, -1))}${Y_SUFFIXES}`;
  } else if (last.endsWith('e')) {
    stem = `${escapeRegExp(last.slice(0, -1))}${E_SUFFIXES}`;
  } else {
    stem = `${escapeRegExp(last)}${REGULAR_SUFFIXES}`;
  }

  const body = [...head, stem].join(' ');
  return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`);
}

const BULLISH_PATTERNS = BULLISH_KEYWORDS.map(keywordPattern);
const BEARISH_PATTERNS = BEARISH_KEYWORDS.map(keywordPattern);

export interface NewsSentiment {
  count: number;
  avgSentiment: number; // -1 to +1
  topics: string[];
}

interface Headline {
  title: string;
  body?: string;
}

/** Distinct keywords from one list present in the text. */
function matchCount(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) hits++;
  }
  return hits;
}

function scoreText(text: string): number {
  const lower = text.toLowerCase();
  return (
    KEYWORD_WEIGHT * matchCount(lower, BULLISH_PATTERNS) -
    KEYWORD_WEIGHT * matchCount(lower, BEARISH_PATTERNS)
  );
}

/**
 * One article's sentiment, from its title and, at lower weight, its body.
 *
 * The body is scored on its own rather than concatenated, so a keyword in both
 * places counts once at full weight and once at the reduced one instead of
 * collapsing into a single hit.
 */
function scoreItem(item: Headline): number {
  const score =
    scoreText(item.title) +
    (item.body ? BODY_WEIGHT_FACTOR * scoreText(item.body) : 0);

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

  // Same boundary and inflection rule as the sentiment keywords: `ban` picked
  // the "regulation" topic out of "bank" and `law` out of "lawn" here too.
  const topicPatterns = Object.entries(topicKeywords).map(
    ([topic, keywords]) => [topic, keywords.map(keywordPattern)] as const
  );

  const found = new Set<string>();

  for (const title of titles) {
    const lower = title.toLowerCase();
    for (const [topic, patterns] of topicPatterns) {
      if (patterns.some((pattern) => pattern.test(lower))) {
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

  const scores = news.map(scoreItem);
  const avgSentiment = scores.reduce((sum, s) => sum + s, 0) / scores.length;

  return {
    count: news.length,
    avgSentiment,
    topics: extractTopics(news.map((n) => n.title)),
  };
}
