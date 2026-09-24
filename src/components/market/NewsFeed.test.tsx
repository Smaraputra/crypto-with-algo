import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/hooks/useNews', () => ({
  useLatestNews: vi.fn(),
}));

import { NEWS_FEEDS } from '@/lib/external/news-feeds';
import { NewsFeed } from './NewsFeed';
import { useLatestNews } from '@/hooks/useNews';
import type { CryptoNewsItem } from '@/types/news';

const mockArticle: CryptoNewsItem = {
  id: '1',
  title: 'Bitcoin hits new high',
  url: 'https://example.com/btc',
  source: 'CoinDesk',
  body: 'Bitcoin reached...',
  categories: 'BTC',
  publishedOn: Math.floor(Date.now() / 1000) - 3600,
  imageUrl: null,
};

describe('NewsFeed', () => {
  it('shows loading state', () => {
    vi.mocked(useLatestNews).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<NewsFeed />);
    expect(screen.getByTestId('news-feed-loading')).toBeInTheDocument();
  });

  it('shows error state', () => {
    vi.mocked(useLatestNews).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<NewsFeed />);
    expect(screen.getByTestId('news-feed-error')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    vi.mocked(useLatestNews).mockReturnValue({
      data: { articles: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<NewsFeed />);
    expect(screen.getByTestId('news-feed-empty')).toBeInTheDocument();
  });

  it('renders news cards', () => {
    vi.mocked(useLatestNews).mockReturnValue({
      data: { articles: [mockArticle] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<NewsFeed />);
    expect(screen.getByTestId('news-feed')).toBeInTheDocument();
    expect(screen.getByText('Bitcoin hits new high')).toBeInTheDocument();
    // Scoped to the card: the attribution footer also names CoinDesk, so an
    // unscoped getByText now matches twice.
    expect(
      within(screen.getByTestId('news-card')).getByText('CoinDesk')
    ).toBeInTheDocument();
  });

  it('shows relative time', () => {
    vi.mocked(useLatestNews).mockReturnValue({
      data: { articles: [mockArticle] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<NewsFeed />);
    expect(screen.getByText('1h ago')).toBeInTheDocument();
  });

  it('limits to 10 articles', () => {
    const articles = Array.from({ length: 15 }, (_, i) => ({
      ...mockArticle,
      id: String(i),
      title: `Article ${i}`,
    }));

    vi.mocked(useLatestNews).mockReturnValue({
      data: { articles },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<NewsFeed />);
    const cards = screen.getAllByTestId('news-card');
    expect(cards).toHaveLength(10);
  });

  it('credits the publishers the headlines actually come from', () => {
    // This asserted "CryptoPanic" for months after the provider moved to
    // publisher RSS, crediting a service the app no longer calls. The
    // attribution now renders from NEWS_FEEDS, so it cannot drift again, and
    // this test reads the same list rather than restating the names.
    vi.mocked(useLatestNews).mockReturnValue({
      data: { articles: [mockArticle] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<NewsFeed />);

    for (const feed of NEWS_FEEDS) {
      const link = screen.getByRole('link', { name: feed.source });
      expect(link).toHaveAttribute('href', feed.siteUrl);
    }
    expect(screen.queryByText(/CryptoPanic/i)).not.toBeInTheDocument();
  });
});
