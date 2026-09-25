import { describe, it, expect } from 'vitest';
import { analyzeNewsSentiment, extractTopics } from './news-sentiment';

describe('analyzeNewsSentiment', () => {
  it('should return zero sentiment for empty news', () => {
    const result = analyzeNewsSentiment([]);
    expect(result).toEqual({
      count: 0,
      avgSentiment: 0,
      topics: [],
    });
  });

  it('should detect bullish sentiment', () => {
    const news = [
      { title: 'Bitcoin rally continues as ETF approval expected' },
      { title: 'Ethereum surge after major upgrade launch' },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.count).toBe(2);
    expect(result.avgSentiment).toBeGreaterThan(0);
    expect(result.topics).toContain('institutional');
  });

  it('should detect bearish sentiment', () => {
    const news = [
      { title: 'Bitcoin crash after exchange hack' },
      { title: 'SEC lawsuit threatens crypto regulation' },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.count).toBe(2);
    expect(result.avgSentiment).toBeLessThan(0);
    expect(result.topics).toContain('security');
    expect(result.topics).toContain('regulation');
  });

  it('should detect mixed sentiment', () => {
    const news = [
      { title: 'Bitcoin rally hits new highs' },
      { title: 'Ethereum crash on network issues' },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.count).toBe(2);
    // Mixed sentiment should be close to zero
    expect(Math.abs(result.avgSentiment)).toBeLessThan(0.5);
  });

  it('should extract DeFi topics', () => {
    const result = analyzeNewsSentiment([{ title: 'DeFi yield farming reaches new highs' }]);
    expect(result.topics).toContain('defi');
  });

  it('should extract NFT topics', () => {
    const result = analyzeNewsSentiment([{ title: 'OpenSea NFT sales surge in metaverse boom' }]);
    expect(result.topics).toContain('nft');
  });

  it('should clamp sentiment scores to [-1, 1]', () => {
    const result = analyzeNewsSentiment([{ title: 'Bitcoin rally surge breakout gain bull' }]);
    expect(result.avgSentiment).toBeLessThanOrEqual(1);
    expect(result.avgSentiment).toBeGreaterThanOrEqual(-1);
  });
});

describe('extractTopics', () => {
  it('returns unique topics across headlines', () => {
    const topics = extractTopics([
      'SEC regulation looms over exchanges',
      'New government law targets mining difficulty',
    ]);

    expect(topics).toContain('regulation');
    expect(topics).toContain('mining');
    expect(new Set(topics).size).toBe(topics.length);
  });
});

describe('keyword matching is lexical, not substring', () => {
  // Measured before the fix: `ban` matched bank, banking, interbank, urban,
  // Albania, bands and banner, so institutional bank-adoption headlines scored
  // BEARISH. `gain` matched "again" and `rise` matched "surprise".
  const falsePositives = [
    'Major bank adds bitcoin custody for clients',
    'Interbank settlement moves on-chain',
    'Urban wallets see record usage',
    'Albania drafts a digital asset framework',
    'Trading bands widen across venues',
    'Exchange banner ads draw scrutiny',
  ];

  it('does not read a bearish tilt out of words that merely contain a keyword', () => {
    for (const title of falsePositives) {
      const { avgSentiment } = analyzeNewsSentiment([{ title }]);
      expect(avgSentiment, title).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not read "again" as a gain or "surprise" as a rise', () => {
    expect(analyzeNewsSentiment([{ title: 'Bitcoin tests support again' }]).avgSentiment).toBe(0);
    expect(analyzeNewsSentiment([{ title: 'Payrolls surprise markets' }]).avgSentiment).toBe(0);
  });

  it('still fires on the keyword itself', () => {
    expect(analyzeNewsSentiment([{ title: 'Regulators ban leveraged products' }]).avgSentiment)
      .toBeLessThan(0);
    expect(analyzeNewsSentiment([{ title: 'Bitcoin posts a gain' }]).avgSentiment)
      .toBeGreaterThan(0);
  });
});

describe('keyword matching is stemmed', () => {
  it('reads the inflected forms the unstemmed list missed', () => {
    const base = analyzeNewsSentiment([{ title: 'Bitcoin rally extends' }]).avgSentiment;

    for (const title of ['Bitcoin rallies again today', 'Bitcoin rallied overnight']) {
      expect(analyzeNewsSentiment([{ title }]).avgSentiment, title).toBe(base);
    }
  });

  it('reads the adjective forms of bull and bear, which are the commonest ones', () => {
    expect(analyzeNewsSentiment([{ title: 'Analysts turn bullish on ether' }]).avgSentiment)
      .toBeGreaterThan(0);
    expect(analyzeNewsSentiment([{ title: 'Bearish divergence builds' }]).avgSentiment)
      .toBeLessThan(0);
  });

  it('handles regular suffixes on both directions', () => {
    expect(analyzeNewsSentiment([{ title: 'Token surged on volume' }]).avgSentiment).toBeGreaterThan(0);
    expect(analyzeNewsSentiment([{ title: 'Exchange hacked overnight' }]).avgSentiment).toBeLessThan(0);
    expect(analyzeNewsSentiment([{ title: 'Prices declining into the close' }]).avgSentiment).toBeLessThan(0);
  });
});

describe('scoring reads what selection read', () => {
  // Articles are SELECTED on title plus body plus categories and were SCORED
  // on title alone; 35% of attributed articles had titles not naming their
  // symbol, so the body that won them their place was never read.
  it('counts the body, at less weight than the title', () => {
    const titleOnly = analyzeNewsSentiment([{ title: 'Bitcoin rally broadens' }]).avgSentiment;
    const bodyOnly = analyzeNewsSentiment([
      { title: 'Morning markets wrap', body: 'A broad rally lifted majors overnight.' },
    ]).avgSentiment;

    expect(bodyOnly).toBeGreaterThan(0);
    expect(bodyOnly).toBeLessThan(titleOnly);
  });

  it('does not let a long body saturate the clamp on one repeated word', () => {
    const repeated = Array.from({ length: 40 }, () => 'The rally continued.').join(' ');
    const { avgSentiment } = analyzeNewsSentiment([
      { title: 'Markets wrap', body: repeated },
    ]);

    expect(avgSentiment).toBeLessThan(0.3);
  });
});
