'use client';

import { ExternalLink } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useLatestNews } from '@/hooks/useNews';
import type { CryptoNewsItem } from '@/types/news';

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function NewsCard({ article }: { article: CryptoNewsItem }) {
  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-md border border-border p-2 hover:bg-muted/50 transition-colors"
      data-testid="news-card"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium line-clamp-2">{article.title}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted-foreground">{article.source}</span>
            <span className="text-xs text-muted-foreground">
              {timeAgo(article.publishedOn)}
            </span>
          </div>
        </div>
        <ExternalLink className="size-3 text-muted-foreground flex-shrink-0 mt-0.5" />
      </div>
    </a>
  );
}

export function NewsFeed() {
  const { data, isLoading, isError } = useLatestNews();

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="news-feed-loading">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4" data-testid="news-feed-error">
        Unable to load news.
      </p>
    );
  }

  const articles = data?.articles ?? [];

  if (articles.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4" data-testid="news-feed-empty">
        No news available.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 max-h-[400px] overflow-y-auto" data-testid="news-feed">
      {articles.slice(0, 10).map((article) => (
        <NewsCard key={article.id} article={article} />
      ))}
    </div>
  );
}
