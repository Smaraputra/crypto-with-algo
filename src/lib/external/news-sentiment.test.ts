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
