import { describe, it, expect } from 'vitest';
import { analyzeNewsSentiment, type NewsItem } from './sentiment-analysis';

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
    const news: NewsItem[] = [
      {
        title: 'Bitcoin rally continues as ETF approval expected',
        url: 'https://example.com/1',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
      {
        title: 'Ethereum surge after major upgrade launch',
        url: 'https://example.com/2',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.count).toBe(2);
    expect(result.avgSentiment).toBeGreaterThan(0);
    expect(result.topics).toContain('institutional');
  });

  it('should detect bearish sentiment', () => {
    const news: NewsItem[] = [
      {
        title: 'Bitcoin crash after exchange hack',
        url: 'https://example.com/1',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
      {
        title: 'SEC lawsuit threatens crypto regulation',
        url: 'https://example.com/2',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.count).toBe(2);
    expect(result.avgSentiment).toBeLessThan(0);
    expect(result.topics).toContain('security');
    expect(result.topics).toContain('regulation');
  });

  it('should detect mixed sentiment', () => {
    const news: NewsItem[] = [
      {
        title: 'Bitcoin rally hits new highs',
        url: 'https://example.com/1',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
      {
        title: 'Ethereum crash on network issues',
        url: 'https://example.com/2',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.count).toBe(2);
    // Mixed sentiment should be close to zero
    expect(Math.abs(result.avgSentiment)).toBeLessThan(0.5);
  });

  it('should extract DeFi topics', () => {
    const news: NewsItem[] = [
      {
        title: 'DeFi yield farming reaches new highs',
        url: 'https://example.com/1',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.topics).toContain('defi');
  });

  it('should extract NFT topics', () => {
    const news: NewsItem[] = [
      {
        title: 'OpenSea NFT sales surge in metaverse boom',
        url: 'https://example.com/1',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.topics).toContain('nft');
  });

  it('should clamp sentiment scores to [-1, 1]', () => {
    const news: NewsItem[] = [
      {
        title: 'Bitcoin rally surge breakout gain bull',
        url: 'https://example.com/1',
        publishedAt: Date.now(),
        source: 'CryptoNews',
      },
    ];

    const result = analyzeNewsSentiment(news);
    expect(result.avgSentiment).toBeLessThanOrEqual(1);
    expect(result.avgSentiment).toBeGreaterThanOrEqual(-1);
  });
});
