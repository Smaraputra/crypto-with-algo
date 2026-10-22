import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinHeadlines } from './CoinHeadlines';
import type { CryptoNewsItem } from '@/types/news';

const { mockUseLatestNews } = vi.hoisted(() => ({
  mockUseLatestNews: vi.fn(),
}));

vi.mock('@/hooks/useNews', () => ({
  useLatestNews: (categories?: string) => mockUseLatestNews(categories),
}));

describe('CoinHeadlines', () => {
  const refetch = vi.fn();
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    mockUseLatestNews.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
      refetch,
    });

    render(<CoinHeadlines symbol="BTCUSDT" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading headlines...');
    expect(screen.getByText('Headlines')).toBeInTheDocument();
    expect(screen.getByText('Context, not a signal')).toBeInTheDocument();
  });

  it('renders error state and retries on click', () => {
    mockUseLatestNews.mockReturnValue({
      isLoading: false,
      error: new Error('Failed to fetch headlines'),
      data: undefined,
      refetch,
    });

    render(<CoinHeadlines symbol="BTCUSDT" />);

    expect(
      screen.getByText('Could not load headlines: Failed to fetch headlines.')
    ).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toHaveClass('min-h-11');
    fireEvent.click(retryBtn);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders empty state when no articles match', () => {
    mockUseLatestNews.mockReturnValue({
      isLoading: false,
      error: null,
      data: { articles: [] },
      refetch,
    });

    render(<CoinHeadlines symbol="BTCUSDT" />);

    expect(
      screen.getByText('No recent headlines mention this coin.')
    ).toBeInTheDocument();
  });

  it('strips USDT suffix, enforces 5-item cap, and verifies external link attributes', () => {
    const articles: CryptoNewsItem[] = Array.from({ length: 8 }, (_, i) => ({
      id: `article-${i}`,
      title: `Headline ${i + 1}`,
      url: `https://example.com/news/${i + 1}`,
      source: `Source ${i + 1}`,
      body: `Body ${i + 1}`,
      categories: 'BTC',
      publishedOn: now - i * 3600, // i hours ago
      imageUrl: null,
    }));

    mockUseLatestNews.mockReturnValue({
      isLoading: false,
      error: null,
      data: { articles },
      refetch,
    });

    render(<CoinHeadlines symbol="BTCUSDT" />);

    // Checked baseAsset passed to hook
    expect(mockUseLatestNews).toHaveBeenCalledWith('BTC');

    // Heading and Tag
    expect(screen.getByText('Headlines')).toBeInTheDocument();
    expect(screen.getByText('Context, not a signal')).toBeInTheDocument();

    // 5-item cap
    const items = screen.getAllByTestId('headline-item');
    expect(items).toHaveLength(5);

    // Verify first link attributes
    const firstLink = screen.getByRole('link', { name: /Headline 1/ });
    expect(firstLink).toHaveAttribute('href', 'https://example.com/news/1');
    expect(firstLink).toHaveAttribute('target', '_blank');
    expect(firstLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(firstLink).toHaveClass('min-h-11');

    // Verify source and age
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
    expect(screen.getByText('Source 2')).toBeInTheDocument();
    expect(screen.getByText('1h ago')).toBeInTheDocument();
  });
});
