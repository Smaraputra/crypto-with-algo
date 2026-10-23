import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CoinHeadlines } from './CoinHeadlines';

const mockUseLatestNews = vi.fn();

vi.mock('@/hooks/useNews', () => ({
  useLatestNews: (categories?: string) => mockUseLatestNews(categories),
}));

describe('CoinHeadlines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders up to five headlines with external link attributes, source, and relative time', () => {
    const now = Date.now();
    const articles = Array.from({ length: 7 }, (_, i) => ({
      id: `art-${i}`,
      title: `Article Title ${i}`,
      url: `https://example.com/news/${i}`,
      source: `Source ${i}`,
      body: `Body ${i}`,
      categories: 'BTC',
      publishedOn: Math.floor((now - i * 3600_000) / 1000),
      imageUrl: null,
    }));

    mockUseLatestNews.mockReturnValue({
      data: { articles },
      isError: false,
    });

    render(<CoinHeadlines symbol="BTCUSDT" />);

    expect(mockUseLatestNews).toHaveBeenCalledWith('BTC');
    expect(screen.getByText('Headlines')).toBeInTheDocument();

    // Max 5 articles
    expect(screen.getByText('Article Title 0')).toBeInTheDocument();
    expect(screen.getByText('Article Title 4')).toBeInTheDocument();
    expect(screen.queryByText('Article Title 5')).not.toBeInTheDocument();

    const link = screen.getByRole('link', { name: /article title 0/i });
    expect(link).toHaveAttribute('href', 'https://example.com/news/0');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Source 0')).toBeInTheDocument();
  });

  it('renders error notice when headlines fail to load', () => {
    mockUseLatestNews.mockReturnValue({
      data: undefined,
      isError: true,
    });

    render(<CoinHeadlines symbol="BTCUSDT" />);
    expect(screen.getByText('Headlines did not load.')).toBeInTheDocument();
  });

  it('decodes HTML entities in headline title and source', () => {
    mockUseLatestNews.mockReturnValue({
      data: {
        articles: [
          {
            id: 'art-encoded',
            title: 'Bitcoin in &#39;Wait&#39; &amp; see',
            url: 'https://example.com/news/encoded',
            source: 'CoinDesk &amp; Partners',
            body: '',
            categories: 'BTC',
            publishedOn: Math.floor(Date.now() / 1000),
            imageUrl: null,
          },
        ],
      },
      isError: false,
    });

    render(<CoinHeadlines symbol="BTCUSDT" />);
    expect(screen.getByText("Bitcoin in 'Wait' & see")).toBeInTheDocument();
    expect(screen.getByText('CoinDesk & Partners')).toBeInTheDocument();
  });
});
